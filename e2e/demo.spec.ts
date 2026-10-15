/**
 * The twelve-step end-to-end demonstration from the brief, run in a real
 * browser against the real built bundle.
 *
 *   1  open the application
 *   2  enter plot dimensions and home requirements
 *   3  generate a real 2D floor plan
 *   4  select and resize a room
 *   5  ask the assistant to add another room
 *   6  see the change reflected in the 2D plan
 *   7  switch to 3D and inspect the building
 *   8  walk through the interior
 *   9  run layout validation and review a real issue
 *  10  correct the issue and confirm the result
 *  11  save, reload, confirm the design persisted
 *  12  export and verify the exported file is valid
 *
 * Every assertion is made against the running application's DOM, against
 * pixels it rendered, or against a file the browser actually downloaded.
 * Nothing here asserts that a source file exists or that a build command
 * exited zero.
 *
 * One caveat, stated here so it is not mistaken for more than it is: step 5
 * talks to `e2e/fake-minimax.mjs`, a scripted stand-in for MiniMax's Messages
 * endpoint, because this run has no API key. Everything downstream of the
 * network call is real — the request the app builds, the strict plan parser,
 * the precondition checks, the tool registry, the store, the recalculation
 * and the UI. What is stubbed is the language understanding, nothing else.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The reader the app itself uses on import, so "this file opens" is checked
// with the app's own code rather than a reimplementation of it.
import { fromJSON } from '../src/model/serialize.ts';

const FAKE = 'http://127.0.0.1:8799';

let context: BrowserContext;
let page: Page;
let artefacts = '';
let pageErrors: string[] = [];

/** What the run established, so later steps can check against it. */
const seen: Record<string, number> = {};

/** Rooms rendered in the plan, as `[roomId, kind]` pairs. */
async function roomsInPlan(): Promise<Array<[string, string | null]>> {
  return page.$$eval('[data-testid="room"]', (els) =>
    els.map((e) => [e.getAttribute('data-room-id') ?? '', e.getAttribute('data-kind')] as [string, string | null]),
  );
}

/** The net indoor area the measurement engine currently reports, in m². */
const netArea = async (): Promise<number> =>
  Number((await page.textContent('[data-testid="stat-net"]'))?.replace(/[^0-9.]/g, '') ?? '0');

/**
 * A cheap signature of what the 3D view is actually showing.
 *
 * The canvas is created with `preserveDrawingBuffer`, so this reads real
 * pixels rather than asking the app what it thinks it drew — which is the
 * point, because "the camera moved" should be observable, not asserted.
 */
async function viewSignature(): Promise<number> {
  return page.getByTestId('scene-3d').evaluate((el) => {
    const src = el.querySelector('canvas') as HTMLCanvasElement | null;
    if (!src) return -1;
    const s = document.createElement('canvas');
    s.width = 48;
    s.height = 30;
    const ctx = s.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(src, 0, 0, 48, 30);
    const d = ctx.getImageData(0, 0, 48, 30).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4) {
      h ^= d[i]! + d[i + 1]! * 3 + d[i + 2]! * 7;
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  });
}

test.beforeAll(async ({ browser }) => {
  artefacts = fs.mkdtempSync(path.join(os.tmpdir(), 'argon-e2e-'));
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  pageErrors = [];
  // Keep the stack. `String(e)` alone gives "WrongDocumentError: ..." with no
  // indication of which call produced it, which is how a stray rejected
  // promise can sit unexamined for a whole run before anyone works out that it
  // came from a third-party control rather than from this app.
  page.on('pageerror', (e) => pageErrors.push(e.stack ? `${String(e)}\n${e.stack}` : String(e)));
});

test.afterAll(async () => {
  await context.close();
});

test.describe.configure({ mode: 'serial' });

test.describe('the twelve-step demonstration', () => {
  test('1 — the application opens', async () => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('project-name')).toBeVisible();
    await expect(page.getByTestId('status-bar')).toBeVisible();
    // A blank project opens on the wizard, which is step 2 of the demo.
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await expect(page.getByText('Plan your home')).toBeVisible();
  });

  test('2 — plot dimensions and home requirements are entered', async () => {
    await page.getByTestId('plot-width').fill('18');
    await page.getByTestId('plot-depth').fill('14');
    await page.getByRole('button', { name: 'Two', exact: true }).click();
    // The wizard reports the room those numbers leave to build on.
    await expect(page.getByText(/Room to build on/)).toBeVisible();

    // The rooms are on the same screen as the plot — there is no step to pass
    // through, because asking for a plan should not require a questionnaire.
    await expect(page.getByTestId('room-living')).toBeVisible();
    await page.getByTestId('room-living').check();
    await page.getByTestId('room-bedroom').check();

    // Everything else is one disclosure away, not three screens.
    await page.getByTestId('wizard-more').click();
    await expect(page.getByTestId('pref-accessibility')).toBeVisible();
    await page.getByTestId('pref-accessibility').click();
    await page.getByTestId('wizard-more').click();

    await expect(page.getByTestId('wizard-generate')).toBeVisible();
  });

  test('3 — a real 2D floor plan is generated', async () => {
    await page.getByTestId('wizard-generate').click();
    await expect(page.getByTestId('onboarding')).toBeHidden();

    const rooms = await roomsInPlan();
    expect(rooms.length, 'the plan must contain real room objects').toBeGreaterThan(1);
    for (const [id, kind] of rooms) {
      expect(id, 'every room must carry a stable id').toMatch(/^rm_/);
      expect(kind, 'every room must carry its kind').toBeTruthy();
    }

    // Walls and openings are separate objects, not decoration in one image.
    expect(await page.locator('[data-testid="walls"] > g').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-testid="rooms"] > g').count()).toBe(rooms.length);

    // The measurements were computed from geometry.
    const net = await netArea();
    expect(net).toBeGreaterThan(10);
    seen.netAfterGenerate = net;

    // Two storeys were asked for, so the navigator has to offer both.
    expect(await page.getByTestId('floor-row').count()).toBe(2);
    await page.screenshot({ path: path.join(artefacts, '03-generated-plan.png') });
  });

  test('4 — a room is selected and resized', async () => {
    const rooms = await roomsInPlan();
    const target = rooms.find(([, k]) => k === 'living') ?? rooms[0]!;
    seen.roomId = 0;
    const roomId = target[0];

    // Click inside the room but off-centre, so the click cannot land on a
    // wall drawn across the middle of it.
    const g = page.locator(`[data-room-id="${roomId}"]`);
    const box = (await g.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);

    await expect(page.getByTestId('room-label')).toBeVisible();
    const label = await page.inputValue('[data-testid="room-label"]');
    expect(label.length).toBeGreaterThan(0);

    const width = page.getByTestId('num-w');
    const original = Number(await width.inputValue());
    const areaBefore = Number((await page.textContent('[data-testid="room-area"]'))?.replace(/[^0-9.]/g, ''));
    const depth = Number(await page.getByTestId('num-d').inputValue());

    await width.fill(String(original + 1.5));
    await page.getByTestId('room-label').click();

    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(original + 1.5, 2);
    // The area readout is the measurement engine's, not a typed-in number.
    const areaAfter = Number((await page.textContent('[data-testid="room-area"]'))?.replace(/[^0-9.]/g, ''));
    expect(areaAfter).toBeCloseTo(areaBefore + 1.5 * depth, 0);

    // Undo and redo go through the same history the toolbar exposes.
    await page.getByTestId('undo').click();
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(original, 2);
    await page.getByTestId('redo').click();
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(original + 1.5, 2);
    await page.screenshot({ path: path.join(artefacts, '04-room-resized.png') });
  });

  test('5 — the assistant is asked to add a room', async () => {
    // The panel is open by default; the toolbar button toggles, so only press
    // it when it is actually shut.
    if (await page.getByTestId('toggle-assistant').getAttribute('aria-pressed') !== 'true') {
      await page.getByTestId('toggle-assistant').click();
    }
    await expect(page.getByTestId('assistant-panel')).toBeVisible();

    // The app must be configured to reach a model at all, or the send button
    // would be disabled and the step would pass vacuously.
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBe(true);
    const cfg = (await health.json()) as { aiEnabled?: boolean; model?: string | null; provider?: string };
    expect(cfg.aiEnabled, 'the server must report a configured model').toBe(true);
    expect(cfg.provider).toBe('minimax');
    expect(cfg.model).toBe('MiniMax-M3');
    // The panel fetched health too: it shows the model it is about to call.
    await expect(page.locator('.chip', { hasText: 'MiniMax-M3' })).toBeVisible();

    seen.roomsBefore = (await roomsInPlan()).length;

    await page.getByTestId('assistant-input').fill('Add a small study next to the largest room.');
    // Enabled only when there is something to send *and* a reachable model,
    // so this single assertion covers both the draft and the health check.
    await expect(page.getByTestId('assistant-send')).toBeEnabled();
    await page.getByTestId('assistant-send').click();
    await expect(page.getByTestId('assistant-reply')).toBeVisible({ timeout: 45_000 });

    // The turn really went over the network with the typed tool registry.
    const logged = (await (await fetch(`${FAKE}/__requests`)).json()) as Array<{
      authorization: string;
      toolCount: number;
      system: string | null;
      model: string;
    }>;
    expect(logged.length).toBeGreaterThan(0);
    const call = logged[logged.length - 1]!;
    expect(call.authorization).toMatch(/^Bearer /);
    expect(call.toolCount, 'the model must be offered the typed tool registry').toBeGreaterThan(20);
    expect(call.system, 'the app must send a system prompt').toMatch(/units are metres/i);
    // The prompt must state the two rules that make the model safe to run.
    expect(call.system).toMatch(/never invent an id/i);
    expect(call.system).toMatch(/call calculate_/i);
    await page.screenshot({ path: path.join(artefacts, '05-assistant.png') });
  });

  test('6 — the change is reflected in the 2D plan', async () => {
    const rooms = await roomsInPlan();
    expect(rooms.length, 'a room must have been added to the plan').toBe(seen.roomsBefore + 1);
    expect(rooms.some(([, k]) => k === 'office'), 'the study must exist as a room object').toBe(true);

    // The assistant showed its own steps, so the edit is not a black box.
    await expect(page.getByTestId('assistant-steps')).toBeVisible();
    await expect(page.getByTestId('assistant-steps')).toContainText(/study|room/i);

    // The engine recomputed the area; the model never supplied it.
    const net = await netArea();
    expect(net).toBeGreaterThan(seen.netAfterGenerate);
    seen.netAfterAssistant = net;
    await page.screenshot({ path: path.join(artefacts, '06-assistant-change.png') });
  });

  test('7 — the building is inspected in 3D', async () => {
    await page.getByTestId('view-3d').click();
    const scene = page.getByTestId('scene-3d');
    await expect(scene).toBeVisible();
    await expect(scene.locator('canvas')).toBeVisible();

    // WebGL produced actual pixels, and they are not a flat clear colour.
    await expect.poll(() => viewSignature(), { timeout: 30_000 }).not.toBe(-1);
    const orbit = await viewSignature();
    expect(orbit).not.toBe(0);

    // The named views are real camera changes, observable as new pixels.
    await page.getByTestId('camera-top').click();
    await expect(page.getByTestId('camera-top')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => viewSignature(), { timeout: 15_000 }).not.toBe(orbit);
    const top = await viewSignature();

    await page.getByTestId('camera-orbit').click();
    await expect.poll(() => viewSignature(), { timeout: 15_000 }).not.toBe(top);
    await page.screenshot({ path: path.join(artefacts, '07-three-d.png') });
  });

  test('8 — the interior can be walked', async () => {
    await page.getByTestId('camera-walk').click();
    await expect(page.getByText(/W A S D to walk/)).toBeVisible();
    await page.waitForTimeout(500);
    const before = await viewSignature();

    // The walk controller listens on the window, so movement does not depend
    // on pointer lock succeeding in a headless browser.
    for (const key of ['KeyW', 'KeyW', 'KeyW', 'KeyD', 'KeyS', 'KeyA']) {
      await page.keyboard.down(key);
      await page.waitForTimeout(220);
      await page.keyboard.up(key);
    }
    // Pushing into a wall for a while must not throw or tunnel.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    await page.keyboard.up('KeyW');

    await expect.poll(() => viewSignature(), { timeout: 15_000 }).not.toBe(before);
    expect(pageErrors, 'walking must not throw').toEqual([]);
    await page.screenshot({ path: path.join(artefacts, '08-walk.png') });

    // Escape, which is what the on-screen HUD tells the user to press.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('camera-orbit')).toHaveAttribute('aria-pressed', 'true');

    // `force` skips Playwright's actionability pre-check, and only here. Under
    // software rendering Playwright's hit test on this toolbar button reports a
    // camera button that `document.elementsFromPoint` shows is nowhere near
    // it: the real element stack at that point is [view-plan, its group, the
    // header, the page], and a dispatched click at the same coordinates does
    // switch the view. The click below is a real DOM click on the located
    // element, and the assertion that follows is the real check.
    await page.getByTestId('view-plan').click({ force: true });
    await expect(page.getByTestId('plan-canvas')).toBeVisible();
  });

  test('9 — validation reports a real issue', async () => {
    await page.getByRole('tab', { name: 'Checks' }).click();

    // The assistant placed the study on top of another room; the constraint
    // engine must say so, name the objects, and quantify the problem.
    const code = page.locator('code', { hasText: 'room_overlap' }).first();
    await expect(code, 'the overlap the assistant caused must be reported').toBeVisible();
    const message = (await code.locator('xpath=..').textContent()) ?? '';
    expect(message).toMatch(/overlap by [\d.]+ m²/);
    expect(message).toMatch(/Study|Office|Living/i);
    await page.screenshot({ path: path.join(artefacts, '09-validation-issue.png') });
  });

  test('10 — the issue is corrected and the result confirmed', async () => {
    const before = (await roomsInPlan()).length;
    // The engine's own deterministic correction, offered as a button.
    const fix = page.locator('button', { hasText: /^Shrink / }).first();
    await expect(fix).toBeVisible();
    await fix.click();

    await expect(page.locator('code', { hasText: 'room_overlap' })).toHaveCount(0);
    // A shrink, not a delete — the study is still part of the plan.
    expect((await roomsInPlan()).length).toBe(before);
    await page.screenshot({ path: path.join(artefacts, '10-issue-corrected.png') });
  });

  test('11 — the project survives a reload', async () => {
    // Make a real change, so there is genuinely something to save.
    const name = page.getByTestId('project-name');
    await name.fill('Argon demo home');
    const roomsBefore = (await roomsInPlan()).length;
    const netBefore = await netArea();

    await page.getByTestId('file-menu').click();
    const saveNow = page.getByRole('button', { name: /Save now/ });
    await expect(saveNow).toBeEnabled();
    await saveNow.click();
    // The menu closes, so the click was handled — previously this button was
    // permanently disabled and the assertion that followed was passing only
    // because nothing had happened.
    await expect(saveNow).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('plan-canvas')).toBeVisible({ timeout: 20_000 });
    // The wizard does not come back: the project was loaded, not reset.
    await expect(page.getByTestId('onboarding')).toBeHidden();
    expect((await roomsInPlan()).length).toBe(roomsBefore);
    expect(await netArea()).toBeCloseTo(netBefore, 1);
    await expect(page.getByTestId('project-name')).toHaveValue('Argon demo home');
    await page.screenshot({ path: path.join(artefacts, '11-after-reload.png') });
  });

  test('12 — the exported files are valid', async () => {
    // JSON — downloaded, parsed, and checked to be this project.
    const jsonWait = page.waitForEvent('download');
    await page.getByTestId('export-menu').click();
    await page.getByTestId('export-json').click();
    const jsonPath = await (await jsonWait).path();
    const text = fs.readFileSync(jsonPath!, 'utf8');
    const envelope = JSON.parse(text) as {
      format: string;
      schemaVersion: number;
      project: { name: string; rooms: unknown[]; floors: unknown[]; plot: { width: number } };
    };
    // A self-describing file, so a wrong file is refused rather than half-read.
    expect(envelope.format).toBe('argon.project');
    expect(typeof envelope.schemaVersion).toBe('number');
    const parsed = envelope.project;
    expect(parsed.name).toBe('Argon demo home');
    expect(parsed.floors.length).toBeGreaterThanOrEqual(2);
    expect(parsed.plot.width).toBeCloseTo(18, 3);

    // The canvas shows one floor and the file holds the whole building, so the
    // counts are not equal by design. What must hold is that every room in the
    // file belongs to a floor in the same file, and that both floors really
    // made it out — an export of only the visible floor would pass a count
    // check against the canvas and lose the rest of the house.
    const floorIds = new Set(parsed.floors.map((f) => (f as { id: string }).id));
    const roomsPerFloor = new Map<string, number>();
    for (const room of parsed.rooms as Array<{ floorId: string; kind: string }>) {
      expect(floorIds.has(room.floorId), `room ${room.kind} references a floor missing from the file`).toBe(true);
      roomsPerFloor.set(room.floorId, (roomsPerFloor.get(room.floorId) ?? 0) + 1);
    }
    expect([...roomsPerFloor.values()].every((n) => n > 0)).toBe(true);
    expect(roomsPerFloor.size).toBe(parsed.floors.length);

    // Every room drawn on screen is in the file, by id.
    const exportedIds = new Set((parsed.rooms as Array<{ id: string }>).map((r) => r.id));
    const visible = await roomsInPlan();
    expect(visible.length).toBeGreaterThan(0);
    for (const [id] of visible) expect(exportedIds.has(id), `room ${id} is drawn but not in the export`).toBe(true);
    seen.exportedRooms = parsed.rooms.length;

    // And it really is an importable project, not just parseable JSON: put the
    // bytes back through the reader the app uses and require the model back.
    const reimported = fromJSON(text);
    expect(reimported.ok, `the exported file did not re-import: ${reimported.ok ? '' : reimported.error}`).toBe(true);
    if (reimported.ok) {
      expect(reimported.project.rooms.length).toBe(parsed.rooms.length);
      expect(reimported.project.name).toBe(parsed.name);
      expect(reimported.project.plot.width).toBeCloseTo(parsed.plot.width, 6);
    }

    // SVG — a real, complete document rather than a truncated string.
    const svgWait = page.waitForEvent('download');
    await page.getByTestId('export-menu').click();
    await page.getByTestId('export-svg').click();
    const svgPath = await (await svgWait).path();
    const svg = fs.readFileSync(svgPath!, 'utf8');
    expect(svg.startsWith('<?xml')).toBe(true);
    expect((svg.match(/<svg[\s>]/g) ?? []).length).toBe(1);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('NaN');
    // Geometry in the document, in millimetres, matching the model.
    expect(svg).toMatch(/width="\d+(\.\d+)?mm"/);

    // Plan PNG — real bytes behind a real PNG signature.
    const pngWait = page.waitForEvent('download');
    await page.getByTestId('export-menu').click();
    await page.getByTestId('export-png').click();
    const pngPath = await (await pngWait).path();
    const png = fs.readFileSync(pngPath!);
    expect(png.length).toBeGreaterThan(1000);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // 3D capture — taken from the live 3D view, same check.
    await page.getByTestId('view-3d').click();
    await expect.poll(() => viewSignature(), { timeout: 30_000 }).not.toBe(-1);
    const glWait = page.waitForEvent('download');
    await page.getByTestId('export-menu').click();
    await page.getByTestId('export-3d').click();
    const glPath = await (await glWait).path();
    const gl = fs.readFileSync(glPath!);
    expect(gl.length).toBeGreaterThan(1000);
    expect(gl.subarray(1, 4).toString('ascii')).toBe('PNG');

    fs.writeFileSync(path.join(artefacts, 'plan.svg'), svg);
    await page.getByTestId('view-plan').click();
    await page.screenshot({ path: path.join(artefacts, '12-after-export.png'), fullPage: true });
  });

  test('the whole run finished with no uncaught errors', async () => {
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    console.log(`\n  artefacts kept at: ${artefacts}`);
    console.log(`  net indoor ${seen.netAfterGenerate} → ${seen.netAfterAssistant} m² after the assistant's edit`);
    console.log(`  ${seen.exportedRooms} rooms exported as JSON, SVG and PNG`);
  });
});
