/**
 * The assistant, driven through the real browser → `/api/chat` → endpoint path.
 *
 * Two promises are checked here, and both of them are about what the *screen*
 * does rather than about what the code says:
 *
 *   1. If the model describes a design in words and applies nothing, the panel
 *      says the plan did not change. A prose layout shown next to an untouched
 *      canvas reads as a completed design, and that is the exact failure
 *      reported: "it hasnt done anything" — while the app implied it had.
 *   2. A multi-step plan is *watched* being applied. The canvas must gain rooms
 *      one at a time, not in a single commit at the end, or the assistant
 *      spends its whole run looking like a stall.
 *
 * `e2e/fake-minimax.mjs` is a script, not a model: the language understanding
 * is stubbed. What is not stubbed is the app — this runs against the built
 * bundle, through the real server, with real ids read out of the real state.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

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

const rooms = () => page.locator('[data-room-id]').count();

/** A fresh browser context, through the wizard, on an empty plot. */
async function emptyPlot() {
  await page.context().close();
  await openContext();
  await page.goto('/');
  await page.getByTestId('onboarding').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('wizard-empty').click();
  await page.getByTestId('onboarding').waitFor({ state: 'hidden', timeout: 30_000 });
  // The panel is open by default; clicking the toggle blindly would close it.
  if ((await page.getByTestId('toggle-assistant').getAttribute('aria-pressed')) !== 'true') {
    await page.getByTestId('toggle-assistant').click();
  }
  await page.getByTestId('assistant-panel').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
}

async function ask(text: string) {
  await page.getByTestId('assistant-input').fill(text);
  await page.getByTestId('assistant-send').click();
}

test.describe('the assistant against a live endpoint', () => {
  test('a design answered in words says, on screen, that nothing changed', async () => {
    await emptyPlot();
    await ask('__PROSE__ build me the complete design: 2 bedrooms, 1 living room, kitchen, bathroom, store room');

    // The turn ends. Whatever the model wrote, the plan must say so itself.
    await page.getByTestId('assistant-nothing-changed').waitFor({ state: 'visible', timeout: 60_000 });
    const notice = await page.getByTestId('assistant-nothing-changed').innerText();
    expect(notice).toMatch(/nothing on the plan changed/i);
    expect(await rooms()).toBe(0);

    // And no step may claim to have applied anything.
    const applied = await page.getByTestId('assistant-steps').count();
    if (applied) {
      expect(await page.locator('[data-testid="assistant-steps"] li').filter({ hasText: '✓' }).count()).toBe(0);
    }
    // The app must not be left claiming a design that is not on the canvas.
    expect(await page.getByTestId('status-bar').innerText()).toMatch(/0\.0 m²|Net indoor/);
  });

  test('a six-room plan is built on the canvas one room at a time', async () => {
    await emptyPlot();

    // Sample the room count from *inside* the page, on the same frame clock the
    // app's own apply loop waits on. Polling from the test process is a round
    // trip per sample, and under load it misses commits entirely — which is
    // how a plan that really did build step by step came to look like one
    // commit, and the test would have been measuring the test.
    await page.evaluate(() => {
      const trace: number[] = [];
      (window as unknown as { __argonRooms: number[] }).__argonRooms = trace;
      const tick = (): void => {
        trace.push(document.querySelectorAll('[data-room-id]').length);
        if (trace.length < 4000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await ask('__FULL__ build me the complete design: living, kitchen, two bedrooms, bathroom and store');

    // The canvas has to admit, while it is working, that the assistant is the
    // thing moving it.
    await expect(async () => expect(await page.getByTestId('assistant-canvas-busy').count()).toBe(1)).toPass({
      timeout: 30_000,
    });

    await expect(async () => expect(await rooms()).toBe(6)).toPass({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    const trace: number[] = await page.evaluate(() => (window as unknown as { __argonRooms: number[] }).__argonRooms);
    const distinct = [...new Set(trace)].sort((a, b) => a - b);

    // Six operations, six frames that added a room. A plan committed in one go
    // leaves exactly one jump in this trace and there is nothing else to see.
    expect(distinct, `room count went ${distinct.join(' → ')} over ${trace.length} frames`).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await page.getByTestId('assistant-log').locator('li').first().waitFor();
    expect(await page.getByTestId('assistant-steps').locator('li').count()).toBe(6);
    expect(await page.getByTestId('assistant-nothing-changed').count()).toBe(0);

    // Every one of them really exists in the model, with the kinds asked for.
    const kinds = await page.$$eval('[data-room-id]', (els) => els.map((e) => e.getAttribute('data-kind')).sort());
    expect(kinds).toEqual(['bathroom', 'bedroom', 'bedroom', 'kitchen', 'living', 'storage']);
  });

  test('no uncaught errors during the run', () => {
    expect(pageErrors).toEqual([]);
  });
});