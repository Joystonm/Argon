/**
 * Mounts the API routes onto the Vite dev server so `npm run dev` is a single
 * process on a single port — no separate API server to remember to start.
 *
 * It also loads `.env`, because the dev server is its own entry point and
 * never runs `server/main.ts`. Without this, `npm run dev` started with an
 * empty `process.env`, and the assistant reported "no key" to anyone who had
 * put one in `.env`. Vite's own `.env` handling does not help: it exposes
 * variables to the client bundle under a `VITE_` prefix, and the API key must
 * never reach the browser.
 *
 * NOTE: the API middleware is registered inside an async factory below, so the
 * dynamic import is awaited before the middleware is used.
 */
import type { Plugin } from 'vite';

export function apiPlugin(): Plugin {
  let mount: ((req: any, res: any, next: any) => void) | null = null;

  return {
    name: 'argon:api',
    async configureServer(server) {
      const { loadEnv } = await import('./env.ts');
      const applied = loadEnv(server.config.root);

      const { createApiApp } = await import('./api.ts');
      const app = createApiApp();
      mount = (req, res, next) => app(req, res, next);
      server.middlewares.use((rq, rs, nx) => {
        if (!mount) return nx();
        return mount(rq, rs, nx);
      });

      const { isConfigured, clientConfig } = await import('./minimax.ts');
      const log = server.config.logger.info.bind(server.config.logger);
      log('\n  Argon API routes mounted at /api/*');
      if (applied.length) log(`  Loaded from .env: ${applied.join(', ')}`);

      if (isConfigured()) {
        const cfg = clientConfig();
        log(`  AI: MiniMax via ${cfg.baseUrl}/v1/messages (model ${cfg.model})\n`);
      } else if (process.env.MINIMAX_API_KEY !== undefined) {
        // Not the common case, but the one that wastes the most time: the
        // variable exists and is empty, which means something upstream set it
        // to "" and the loader — correctly — refused to overwrite it.
        log(
          '  AI: MINIMAX_API_KEY is set but empty, so .env was not used.\n' +
            '     An empty value already in the environment wins over the file.\n',
        );
      } else if (process.env.ARGON_DISABLE_AI === 'true') {
        log('  AI: disabled by ARGON_DISABLE_AI=true\n');
      } else {
        log('  AI: no key. Set MINIMAX_API_KEY in .env and restart the dev server.\n');
      }
    },
  };
}