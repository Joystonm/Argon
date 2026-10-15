/**
 * The inside camera.
 *
 * Three properties, each checked by observation rather than by internals:
 *
 *   1. entering the mode puts the camera *in* a room, and says which;
 *   2. picking a different room moves the camera there;
 *   3. dragging to look does not also click.
 *
 * (3) is the one that could silently break and is nearly invisible when it
 * does: a drag that leaks a click selects whatever was under the cursor, so
 * looking around the room quietly replaces the user's selection. The
 * measurement is deliberately about the click event itself — a listener on the
 * canvas itself, which the capture-phase swallower in `InsideView` sits above —
 * rather than about what happens to be under the pointer, which would make the
 * test depend on the generated plan.
 */
import { expect, test, type Page } from '@playwright/test';

/** Generates the default design and switches to the 3D view. */
async function start(page: Page) {
  await page.goto('/');
  await page.getByTestId('plot-width').fill('18');
  await page.getByTestId('plot-depth').fill('14');
  await page.getByRole('button', { name: 'Two', exact: true }).click();
  for (const tick of ['room-living', 'room-bedroom']) {
    if (await page.getByTestId(tick).isVisible().catch(() => false)) await page.getByTestId(tick).check();
  }
  await page.getByTestId('wizard-generate').click();
  await expect(page.getByTestId('onboarding')).toBeHidden();
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('scene-3d').locator('canvas')).toBeVisible();
}

const canvas = (page: Page) => page.getByTestId('scene-3d').locator('canvas');

test.describe('the inside camera', () => {
  test('opens inside a room, moves to another, and leaves on Escape', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.stack ? `${String(e)}\n${e.stack}` : String(e)));

    await start(page);

    await page.getByTestId('camera-inside').click();
    await expect(page.getByTestId('camera-inside')).toHaveAttribute('aria-pressed', 'true');

    // The readout is computed from the camera's own position against the room
    // rectangles, so a name here means the camera really is inside that room.
    const readout = page.getByTestId('inside-room');
    await expect(readout).not.toHaveText('In the building', { timeout: 15_000 });
    const first = (await readout.textContent())?.trim() ?? '';
    expect(first.length).toBeGreaterThan(0);

    // The picker lists the same rooms, and picking a different one lands there.
    const chips = page.getByTestId('inside-room-chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(1);
    let other: { index: number; label: string } | null = null;
    for (let i = 0; i < count; i++) {
      const label = ((await chips.nth(i).textContent()) ?? '').trim();
      if (label !== first) {
        other = { index: i, label };
        break;
      }
    }
    expect(other, 'expected a room other than the one it opened on').not.toBeNull();
    await chips.nth((other as { index: number }).index).click();
    await expect(readout).toHaveText((other as { label: string }).label, { timeout: 15_000 });

    // Escape is what the HUD tells the user will leave.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('camera-orbit')).toHaveAttribute('aria-pressed', 'true');
    await expect(readout).toBeHidden();

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });

  test('dragging to look around does not click the room', async ({ page }) => {
    await start(page);
    await page.getByTestId('camera-inside').click();

    // Count the clicks that reach the canvas itself. The swallower is a
    // capture-phase listener on the 3D view's wrapper, which is the canvas's
    // ancestor, so a swallowed drag never gets here.
    await canvas(page).evaluate((el) => {
      (el as any).__clicks = 0;
      el.addEventListener('click', () => {
        (el as any).__clicks++;
      });
    });
    const clicks = () => canvas(page).evaluate((el) => (el as any).__clicks as number);

    const box = (await canvas(page).boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // A plain click is a real click and must still reach the app.
    await page.mouse.click(at.x, at.y);
    await expect.poll(clicks, { timeout: 15_000 }).toBe(1);

    // A drag from the same point must not produce one.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 90, at.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await clicks(), 'a look-around drag leaked a click into the scene').toBe(1);
  });
});