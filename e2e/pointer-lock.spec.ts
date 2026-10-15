/**
 * A regression test for an intermittent unhandled rejection.
 *
 * drei's `PointerLockControls`, given no `selector`, attaches its lock trigger
 * to `document`:
 *
 *     const t = () => O.lock();
 *     const n = selector ? [...document.querySelectorAll(selector)] : [document];
 *     n.forEach((e) => e && e.addEventListener('click', t));
 *
 * So every click anywhere in the studio called `requestPointerLock()` on the
 * 3D canvas. When such a click was also what left walk mode, React had already
 * detached the canvas by the time the event finished bubbling, the browser
 * rejected the request with `WrongDocumentError`, and three-stdlib does not
 * catch it — an unhandled rejection, which the twelve-step run caught roughly
 * one run in three.
 *
 * This test asserts the property that actually matters, and asserts it by
 * observation rather than by timing: **no code path in this app may call
 * `requestPointerLock` on an element that is not in the document.** It does not
 * depend on the browser granting a lock, which a headless browser may decline
 * to do for reasons that have nothing to do with this app.
 */
import { expect, test, type Page } from '@playwright/test';

/** Installs a recorder over `requestPointerLock` and returns a reader for it. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const calls: { connected: boolean; tag: string }[] = [];
    (window as any).__lockCalls = calls;
    const original = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function patched(this: Element, ...args: unknown[]) {
      calls.push({ connected: this.isConnected, tag: this.tagName.toLowerCase() });
      // Keep the real behaviour, and keep the rejection handled so this test
      // measures the app rather than accumulating the very error it hunts.
      const result = (original as any).apply(this, args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return result;
    };
  });
}

const lockCalls = (page: Page) =>
  page.evaluate(() => (window as any).__lockCalls as { connected: boolean; tag: string }[]);

test.describe('pointer lock is requested only on a live canvas', () => {
  test('clicks outside the 3D view never ask for pointer lock', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.stack ? `${String(e)}\n${e.stack}` : String(e)));
    await instrument(page);

    await page.goto('/');

    // A plan is needed before there is anything to look at.
    await page.getByTestId('plot-width').fill('18');
    await page.getByTestId('plot-depth').fill('14');
    await page.getByRole('button', { name: 'Two', exact: true }).click();
    for (const tick of ['room-living', 'room-bedroom']) {
      if (await page.getByTestId(tick).isVisible().catch(() => false)) await page.getByTestId(tick).check();
    }
    await page.getByTestId('wizard-generate').click();
    await expect(page.getByTestId('onboarding')).toBeHidden();

    // Walk mode is the only mode that mounts PointerLockControls.
    await page.getByTestId('view-3d').click();
    await expect(page.getByTestId('scene-3d').locator('canvas')).toBeVisible();
    await page.getByTestId('camera-walk').click();
    await expect(page.getByText(/W A S D to walk/)).toBeVisible();

    // The canvas is the documented way in, and it must still ask.
    await page.getByTestId('scene-3d').locator('canvas').click({ position: { x: 200, y: 150 } });
    await expect.poll(() => lockCalls(page).then((c) => c.length)).toBeGreaterThan(0);
    expect(
      (await lockCalls(page)).filter((c) => !c.connected),
      'a lock was requested on a detached element',
    ).toEqual([]);

    // These are the clicks that used to fire it. Each of them switches views
    // and/or panels while walk mode is mounted, which is what detached the
    // canvas underneath a document-level listener.
    //
    // Dispatched rather than driven through the mouse: under software
    // rendering Playwright's hit test reports the 3D canvas intercepting the
    // toolbar, the same interception `e2e/demo.spec.ts` documents for
    // `view-plan`. The event still bubbles to `document`, which is precisely
    // the behaviour under test, and each click is checked below to prove it
    // actually changed the view rather than doing nothing at all.
    const before = (await lockCalls(page)).length;

    await page.getByTestId('camera-top').dispatchEvent('click');
    await expect(page.getByTestId('camera-top')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('camera-walk').dispatchEvent('click');
    await expect(page.getByText(/W A S D to walk/)).toBeVisible();

    await page.getByTestId('camera-orbit').dispatchEvent('click');
    await expect(page.getByTestId('camera-orbit')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('view-plan').dispatchEvent('click');
    await expect(page.getByTestId('plan-canvas')).toBeVisible();
    await page.waitForTimeout(150);

    const after = await lockCalls(page);
    expect(
      after.slice(before).filter((c) => !c.connected),
      'a lock was requested on a detached element',
    ).toEqual([]);
    expect(
      after.length,
      'clicks on the toolbar must not request pointer lock at all — that was the defect',
    ).toBe(before);

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});