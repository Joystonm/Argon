/**
 * Loads `.env` into `process.env`.
 *
 * This lives in its own module because the studio has two entry points — the
 * production server (`server/main.ts`) and the Vite dev server
 * (`server/vite-plugin.ts`) — and only one of them used to load `.env`. The
 * result was that `npm run dev` silently ran with no API key, and the
 * assistant panel correctly reported "no key" while the user could see one in
 * `.env`. Both paths now call `loadEnv()`.
 *
 * Deliberately minimal: no dependency, no interpolation, no override of real
 * environment variables. A variable already in the environment wins, because
 * that is what a deployment does and it is how you turn the assistant off for
 * one process without editing a file on disk.
 */
import path from 'node:path';
import fs from 'node:fs';

/**
 * @param root Project directory — the one that holds `.env`.
 * @returns Keys that were set, so a caller can say something useful about it.
 */
export function loadEnv(root: string): string[] {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return [];

  const applied: string[] = [];
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue; // no '=' , or a line beginning with '='

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!key || key in process.env) continue;

    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}