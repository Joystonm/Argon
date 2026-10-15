/**
 * Playwright configuration for the end-to-end demo.
 *
 * Two servers, because the demo needs both halves of the AI path:
 *   · the stand-in MiniMax endpoint, which the app's own server talks to
 *   · the app itself, built and served by `server/main.ts`
 *
 * The app is served from `dist/`, not from the dev server, so the demo runs
 * against the same bundle `npm run build` produces.
 */
import { defineConfig } from '@playwright/test';

const APP_PORT = 8788;
const FAKE_PORT = 8799;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'retain-on-failure',
    // Headless Chromium has no GPU here, so the 3D view is rendered by
    // SwiftShader. Without these the WebGL context fails and steps 7–8 would
    // pass against a canvas that never drew anything.
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-lcd-text'],
    },
    viewport: { width: 1600, height: 1000 },
  },
  webServer: [
    {
      command: 'node e2e/fake-minimax.mjs',
      env: { FAKE_MINIMAX_PORT: String(FAKE_PORT) },
      url: `http://127.0.0.1:${FAKE_PORT}/__requests`,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `npm run build && node --experimental-strip-types server/main.ts`,
      env: {
        PORT: String(APP_PORT),
        MINIMAX_API_KEY: 'e2e-stand-in-key',
        MINIMAX_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
        MINIMAX_MODEL: 'MiniMax-M3',
      },
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});