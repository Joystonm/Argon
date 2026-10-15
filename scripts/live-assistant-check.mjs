/**
 * TEMPORARY — not part of the committed test suite. Drives the real
 * application against the real MiniMax service to verify the live integration
 * end to end. Costs money and needs a key in `.env`, so it is not a test.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.LIVE_BASE ?? 'http://127.0.0.1:5173';
const ASK = process.env.LIVE_ASK ?? 'Add a small study next to the largest room.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const roomsInPlan = () => page.$$eval('[data-room-id]', (els) => els.map((e) => e.getAttribute('data-room-id')));
const netArea = () =>
  page.textContent('[data-testid="stat-net"]').then((t) => Number((t ?? '').replace(/[^0-9.]/g, '')));

console.log(`→ ${BASE}`);
await page.goto(BASE);

await page.getByTestId('plot-width').fill('18');
await page.getByTestId('plot-depth').fill('14');
await page.getByRole('button', { name: 'Two', exact: true }).click();
for (const tick of ['room-living', 'room-bedroom']) {
  if (await page.getByTestId(tick).isVisible().catch(() => false)) await page.getByTestId(tick).check();
}
await page.getByTestId('wizard-generate').click();
await page.getByTestId('onboarding').waitFor({ state: 'hidden', timeout: 30_000 });

const roomsBefore = (await roomsInPlan()).length;
const netBefore = await netArea();
console.log(`  generated: ${roomsBefore} rooms, net ${netBefore} m²`);

const health = await (await page.request.get(`${BASE}/api/health`)).json();
console.log(`  health: ${JSON.stringify(health)}`);

await page.getByTestId('assistant-input').fill(ASK);
const enabled = await page.getByTestId('assistant-send').isEnabled();
console.log(`  send button enabled: ${enabled}`);
await page.getByTestId('assistant-send').click();

// Wait for the turn to finish rather than for a reply to appear: a failed
// turn is just as interesting as a successful one, and only the panel knows
// what it was. The send button reads "Working…" while busy — it cannot be used
// as the signal, because it is also disabled once the draft is cleared.
try {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="assistant-send"]')?.textContent?.trim() === 'Send',
    null,
    { timeout: 240_000 },
  );
} catch {
  console.log('!! turn did not finish within 240s');
}
await page.waitForTimeout(1500);

if (!(await page.getByTestId('assistant-reply').isVisible().catch(() => false))) {
  console.log('\n--- assistant log (no reply element) ---');
  console.log(await page.textContent('[data-testid="assistant-log"]'));
  console.log('\n--- health after ---');
  console.log(JSON.stringify(await (await page.request.get(`${BASE}/api/health`)).json()));
  console.log(`\n  page errors: ${errors.length ? '\n    ' + errors.join('\n    ') : 'none'}`);
  await page.screenshot({ path: 'live-assistant.png' });
  await browser.close();
  process.exit(1);
}

const steps = await page.textContent('[data-testid="assistant-steps"]').catch(() => '');
const reply = await page.textContent('[data-testid="assistant-reply"]');
const roomsAfter = (await roomsInPlan()).length;
const netAfter = await netArea();

console.log('\n--- pipeline steps ---\n' + (steps ?? '(none)'));
console.log('\n--- reply ---\n' + (reply ?? '(none)'));
console.log('\n--- result ---');
console.log(`  rooms ${roomsBefore} → ${roomsAfter}`);
console.log(`  net   ${netBefore} → ${netAfter} m²`);
console.log(`  changed: ${roomsAfter !== roomsBefore || netAfter !== netBefore}`);

await page.screenshot({ path: 'live-assistant.png', fullPage: false });
console.log('\n  screenshot: live-assistant.png');
console.log(`  page errors: ${errors.length ? '\n    ' + errors.join('\n    ') : 'none'}`);

await browser.close();