/**
 * The editing gestures a floor plan has to get right, run in a real browser
 * against the real built bundle.
 *
 * These are the things that were wrong and that no amount of generated code
 * could prove were right:
 *
 *   · a room cannot be picked up and removed if every click on a wall lands on
 *     the room behind it — which is what happened, because the rooms tile the
 *     whole envelope and were tested before the walls
 *   · the room tool staying armed after a placement means the next click adds
 *     a second room instead of selecting the one in front of it
 *   · a door or a window showed no selected state at all, so pressing Delete
 *     after clicking one looked like nothing had happened
 *   · a room deeper than it is wide is labelled upright, like a drafted plan
 *
 * Every assertion is made against the running application's DOM or against a
 * point it actually responds to. Nothing here asserts that a source file
 * exists or that a build command exited zero.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const BLUE = '#2563eb';
const RED = '#dc2626';

let page: Page;
let browserRef: Browser;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
  await openContext();
});

async function openContext() {
  const context = await browserRef.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
}

test.afterAll(async () => {
  await page.context().close();
});

test.describe.configure({ mode: 'serial' });

/** Rooms in the plan as `[id, kind]`, and the wall and opening counts. */
async function plan() {
  return page.evaluate(() => {
    const rooms = [...document.querySelectorAll('[data-room-id]')].map((g) => [
      g.getAttribute('data-room-id') ?? '',
      g.getAttribute('data-kind') ?? '',
    ] as [string, string]);
    return {
      rooms,
      walls: document.querySelectorAll('[data-wall-id]').length,
      openings: document.querySelectorAll('[data-opening-id]').length,
    };
  });
}

/**
 * What the canvas is painting as selected or in error.
 *
 * Read off the rendered SVG rather than off any application state: a selected
 * room is outlined in the selection blue, a selected wall gets a dashed centre
 * line in the same blue, a selected opening is tinted, and anything breaking a
 * rule is outlined in red. That is exactly what a person looking at the screen
 * can see, so it is what gets asserted.
 */
async function shown(): Promise<string[]> {
  return page.evaluate(
    ({ blue, red }) => {
      const out: string[] = [];
      for (const g of document.querySelectorAll('[data-room-id]')) {
        const id = g.getAttribute('data-room-id');
        const kind = g.getAttribute('data-kind');
        const stroke = [...g.querySelectorAll('rect')].map((r) => r.getAttribute('stroke'));
        if (stroke.includes(blue)) out.push(`room ${kind} ${id}`);
        else if (stroke.includes(red)) out.push(`room ${kind} ${id} (flagged)`);
      }
      for (const g of document.querySelectorAll('[data-wall-id]')) {
        const id = g.getAttribute('data-wall-id');
        const type = g.getAttribute('data-wall-type');
        if (g.querySelector(`line[stroke="${blue}"]`)) out.push(`wall ${type} ${id}`);
        if ([...g.querySelectorAll('polygon')].some((p) => p.getAttribute('fill') === blue)) {
          const o = g.querySelector('[data-opening-id]');
          if (o) out.push(`opening ${o.getAttribute('data-opening-kind')} ${o.getAttribute('data-opening-id')}`);
        }
      }
      return out;
    },
    { blue: BLUE, red: RED },
  );
}

/** A point on bare wall: on the wall band, clear of its doors and windows. */
async function bareWallPoint(): Promise<{ x: number; y: number; id: string } | null> {
  const walls = await page.$$('[data-wall-id]');
  for (const w of walls) {
    const b = await w.boundingBox();
    if (!b || b.width < 40 || b.height < 6) continue;
    const id = await w.getAttribute('data-wall-id');
    const holes = await Promise.all((await page.$$(`[data-wall-id="${id}"] [data-opening-id]`)).map((e) => e.boundingBox()));
    for (let i = 1; i < 20; i++) {
      const x = b.x + (b.width * i) / 20;
      if (holes.some((h) => h && x > h.x - 2 && x < h.x + h.width + 2)) continue;
      return { x, y: b.y + b.height / 2, id: id! };
    }
  }
  return null;
}

async function throughWizard(button: 'wizard-generate' | 'wizard-grid' | 'wizard-empty') {
  // Projects are kept in IndexedDB, so a reload comes back with the previous
  // design already in it and no wizard. A new browser context is the only way
  // back to a first run, which is what "start from ..." means here.
  await page.context().close();
  await openContext();
  await page.goto('/');
  await page.getByTestId('onboarding').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId(button).click();
  await page.getByTestId('onboarding').waitFor({ state: 'hidden', timeout: 30_000 });
  await page.waitForTimeout(800);
}

test.describe('laying out a plan', () => {
  test('a wall can be picked up and removed, though it sits inside two rooms', async () => {
    await throughWizard('wizard-generate');
    const before = await plan();
    expect(before.rooms.length).toBeGreaterThan(3);

    const spot = await bareWallPoint();
    expect(spot, 'a generated plan has wall to click').not.toBeNull();
    await page.mouse.click(spot!.x, spot!.y);

    // The whole point: the wall is inside the rooms it separates, and it is the
    // wall the click has to reach.
    expect(await shown()).toContain(
      `wall ${await page.getAttribute(`[data-wall-id="${spot!.id}"]`, 'data-wall-type')} ${spot!.id}`,
    );

    await page.getByTestId('delete-selection').click();
    await page.waitForTimeout(300);
    expect((await plan()).walls).toBe(before.walls - 1);

    await page.getByTestId('undo').click();
    await page.waitForTimeout(300);
    expect((await plan()).walls).toBe(before.walls);
  });

  test('a door shows itself as selected, so Delete has something to act on', async () => {
    const opening = await page.$('[data-opening-id]');
    const box = await opening!.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(300);
    const before = await plan();
    expect((await shown()).some((s) => s.startsWith('opening '))).toBe(true);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    const after = await plan();
    expect(after.openings).toBe(before.openings - 1);
    expect(after.walls).toBe(before.walls);
    await page.getByTestId('undo').click();
    await page.waitForTimeout(300);
    expect((await plan()).openings).toBe(before.openings);
  });

  test('the right-click menu offers the wall under the cursor', async () => {
    const spot = await bareWallPoint();
    await page.mouse.click(spot!.x, spot!.y, { button: 'right' });
    const title = await page.getByTestId('context-menu-title').innerText();
    expect(title).toMatch(/wall/i);

    const before = await plan();
    await page.getByTestId('context-delete').click();
    await page.waitForTimeout(300);
    expect((await plan()).walls).toBe(before.walls - 1);
    await page.getByTestId('undo').click();
    await page.waitForTimeout(300);
  });

  test('a room type from the palette is placed, and clicking it again picks it up', async () => {
    const canvas = await (await page.$('[data-testid="plan-canvas"] svg')).boundingBox();
    const before = await plan();

    await page.getByTestId('tool-room').click();
    await page.getByTestId('room-kind-kitchen').click();
    // In the strip between the plot edge and the building: the one piece of
    // ground a generated plan has left.
    await page.mouse.click(canvas!.x + 14, canvas!.y + canvas!.height / 2);
    await page.waitForTimeout(400);
    const placed = await plan();
    expect(placed.rooms.length).toBe(before.rooms.length + 1);
    const fresh = placed.rooms.find(([id]) => !before.rooms.some(([b]) => b === id));
    expect(fresh?.[1]).toBe('kitchen');

    // Clicking a room that is already there must select it, not add another
    // one of the pending kind. This is the duplicate the report was about.
    const existing = placed.rooms[0]![0];
    const box = await (await page.$(`[data-room-id="${existing}"]`))!.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(400);
    const afterClick = await plan();
    expect(afterClick.rooms.length).toBe(placed.rooms.length);
    expect((await shown()).some((s) => s.startsWith('room '))).toBe(true);

    // And the room that was placed is removable by the keyboard.
    await page.getByTestId('tool-select').click();
    const kb = await (await page.$(`[data-room-id="${fresh![0]}"]`))!.boundingBox();
    await page.mouse.click(kb!.x + kb!.width / 2, kb!.y + kb!.height / 2);
    await page.waitForTimeout(300);
    // It may read as flagged rather than selected: a room dropped in the
    // setback strip breaks the buildable envelope, and the rule colour is
    // drawn over the selection colour.
    expect((await shown()).some((s) => s.startsWith(`room kitchen ${fresh![0]}`))).toBe(true);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(400);
    expect((await plan()).rooms.length).toBe(before.rooms.length);
  });

  test('picking the room type that is already armed stands the tool down', async () => {
    await page.getByTestId('tool-room').click();
    await page.getByTestId('room-kind-bathroom').click();
    await expect(page.getByTestId('tool-room')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('room-kind-bathroom').click();
    await expect(page.getByTestId('tool-room')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a room deeper than it is wide is labelled upright', async () => {
    const narrow = await page.evaluate(() => {
      const g = [...document.querySelectorAll('[data-room-id]')]
        .map((el) => ({ id: el.getAttribute('data-room-id')!, w: el.getBBox().width, h: el.getBBox().height }))
        .sort((a, b) => a.w / a.h - b.w / b.h)[0];
      if (!g) return null;
      const el = document.querySelector(`[data-room-id="${g.id}"]`)!;
      const text = el.querySelector('text');
      const group = text?.parentElement;
      return {
        id: g.id,
        ratio: g.w / g.h,
        rotated: group?.getAttribute('transform')?.startsWith('rotate(-90') ?? false,
        label: text?.textContent ?? '',
      };
    });
    expect(narrow).not.toBeNull();
    expect(narrow!.ratio, 'the plan has a room that is deeper than it is wide').toBeLessThan(0.8);
    expect(narrow!.rotated, `${narrow!.label} is set upright`).toBe(true);
  });

  test('starting from an empty plot gives the plot and nothing else', async () => {
    await throughWizard('wizard-empty');
    const p = await plan();
    expect(p.rooms).toHaveLength(0);
    expect(p.walls).toBe(0);
    expect(p.openings).toBe(0);
  });

  test('a room can be drawn on the empty plot, and removed again', async () => {
    const canvas = await (await page.$('[data-testid="plan-canvas"] svg')).boundingBox();
    await page.getByTestId('tool-room').click();
    await page.getByTestId('room-kind-bedroom').click();
    await page.mouse.click(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
    await page.waitForTimeout(400);
    const p = await plan();
    expect(p.rooms).toHaveLength(1);
    expect(p.rooms[0]![1]).toBe('bedroom');

    await page.getByTestId('tool-select').click();
    const box = await (await page.$(`[data-room-id="${p.rooms[0]![0]}"]`))!.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.getByTestId('delete-selection').click();
    await page.waitForTimeout(300);
    expect((await plan()).rooms).toHaveLength(0);
  });

  test('starting from a grid tiles the envelope with the rooms that were asked for', async () => {
    await throughWizard('wizard-grid');
    const p = await plan();
    expect(p.rooms.length).toBeGreaterThanOrEqual(4);
    // A grid is a starting point, not a finished plan: it still has real walls
    // and real openings, or there would be nothing to rearrange.
    expect(p.walls).toBeGreaterThan(p.rooms.length);
    expect(p.openings).toBeGreaterThan(0);
  });

  test('no uncaught errors during the run', () => {
    expect(pageErrors).toEqual([]);
  });
});