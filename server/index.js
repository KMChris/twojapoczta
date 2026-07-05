// TwojaPoczta server · one process, no dependencies: node server/index.js

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createRouter } from './router.js';
import { createStaticHandler } from './static.js';
import { registerApiRoutes, requireUser, json } from './api.js';
import { seedIfEmpty } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function setSecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export async function createApp({ dataDir, db } = {}) {
  const database = db ?? openDb(dataDir ?? path.join(ROOT, 'data'));
  await seedIfEmpty(database);

  const router = createRouter();
  const api = registerApiRoutes(router, database);
  const serveStatic = createStaticHandler(path.join(ROOT, 'public'));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    setSecurityHeaders(res);

    try {
      if (url.pathname.startsWith('/api/')) {
        const matched = router.match(req.method, url.pathname);
        if (!matched) return json(res, 404, { error: 'Nie ma takiego adresu API.' });

        let user = null;
        if (!api.isOpen(req.method, url.pathname)) {
          user = requireUser(database, req, res);
          if (!user) return;
        }
        await matched.handler(req, res, { user, params: matched.params, url });
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(`[${new Date().toISOString()}]`, err);
      if (!res.headersSent) {
        json(res, status, { error: status >= 500 ? 'Wystąpił błąd serwera. Spróbuj ponownie.' : err.message });
      } else {
        res.end();
      }
    }
  });

  return { server, db: database };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const HOST = process.env.HOST ?? '127.0.0.1';
  const { server, db } = await createApp({ dataDir: process.env.TP_DATA_DIR });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  \u{1F4EE} TwojaPoczta · http://${HOST}:${PORT}`);
    console.log(`     Konto demo: demo@twojapoczta.com · hasło: demo1234`);
    console.log('');
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
