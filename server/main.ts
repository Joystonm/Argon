/**
 * Production server: serves the built SPA from `dist/` and mounts `/api/*`.
 *
 *   npm run build && npm run serve
 *
 * Reads configuration from the real process environment (or a `.env` file
 * placed next to the project, loaded here for convenience).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiApp } from './api.ts';
import { isConfigured, clientConfig } from './minimax.ts';
import { loadEnv } from './env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

// Shared with the Vite dev server — see server/env.ts.
loadEnv(root);

const app = createApiApp();

if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('*', (_req, res) =>
    res
      .status(503)
      .type('text/plain')
      .send('dist/ not found. Run `npm run build` first, or use `npm run dev`.'),
  );
}

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  const cfg = clientConfig();
  console.log(`\n  Argon running at http://localhost:${port}`);
  if (isConfigured()) console.log(`  AI: MiniMax via ${cfg.baseUrl}/v1/messages (model ${cfg.model})`);
  else
    console.log(
      '  AI: disabled — set MINIMAX_API_KEY in .env. Manual editing works without it.',
    );
  console.log('');
});