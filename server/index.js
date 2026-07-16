// TwojaPoczta server · one process, no dependencies: node server/index.js

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createRouter } from './router.js';
import { createStaticHandler } from './static.js';
import { registerApiRoutes, requireUser, json } from './api.js';
import { seedIfEmpty } from './seed.js';
import { startSmtpServer } from './smtp.js';
import { initDkim, dnsRecord, dkimConfigured } from './dkim.js';
import { DOMAIN, fireScheduled } from './mail.js';
import { grantAdmin } from './admin.js';
import { registerAdminRoutes } from './api-admin.js';

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
  const resolvedDataDir = dataDir ?? path.join(ROOT, 'data');
  const database = db ?? openDb(resolvedDataDir);
  await seedIfEmpty(database);

  // Podpisy DKIM tylko przy realnym wdrożeniu (dysk + włączona wysyłka na zewnątrz).
  if (!db && process.env.TP_EXTERNAL === '1') {
    try {
      initDkim(resolvedDataDir, { domain: DOMAIN });
    } catch (err) {
      console.error('[dkim] nie udało się przygotować klucza:', err.message);
    }
  }

  const router = createRouter();
  const api = registerApiRoutes(router, database);
  registerAdminRoutes(router, database, { dataDir: resolvedDataDir });
  const serveStatic = createStaticHandler(path.join(ROOT, 'public'));

  // Zaplanowane wiadomości: nadaj zaległe od razu (np. po restarcie), potem co pół minuty.
  try {
    fireScheduled(database);
  } catch (err) {
    console.error('[scheduler]', err);
  }
  const zegarNadawania = setInterval(() => {
    try {
      fireScheduled(database);
    } catch (err) {
      console.error('[scheduler]', err);
    }
  }, 30_000);
  zegarNadawania.unref?.();

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

  server.on('close', () => clearInterval(zegarNadawania));

  return { server, db: database };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `npm run dkim`: przygotuj klucz i wydrukuj rekord TXT do DNS.
if (isMain && process.argv.includes('--dkim')) {
  const { wygenerowano, plik } = initDkim(process.env.TP_DATA_DIR ?? path.join(ROOT, 'data'), { domain: DOMAIN });
  const rekord = dnsRecord();
  console.log('');
  console.log(wygenerowano ? '  Wygenerowano nowy klucz DKIM:' : '  Klucz DKIM już istnieje:');
  console.log(`  ${plik}`);
  console.log('');
  console.log('  Dodaj w DNS rekord TXT:');
  console.log(`  ${rekord.nazwa}`);
  console.log(`  "${rekord.wartosc}"`);
  console.log('');
  process.exit(0);
}

// `npm run admin -- <login>`: nadaje kontu uprawnienia administratora bez UI.
if (isMain && process.argv.includes('--admin')) {
  const login = process.argv[process.argv.indexOf('--admin') + 1];
  if (!login) {
    console.error('Użycie: node server/index.js --admin <login>');
    process.exit(1);
  }
  const db = openDb(process.env.TP_DATA_DIR ?? path.join(ROOT, 'data'));
  const nadano = grantAdmin(db, login);
  db.close();
  console.log(nadano ? `Konto ${login} ma teraz uprawnienia administratora.` : `Nie znaleziono konta „${login}".`);
  process.exit(nadano ? 0 : 1);
}

if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const HOST = process.env.HOST ?? '127.0.0.1';
  const { server, db } = await createApp({ dataDir: process.env.TP_DATA_DIR });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  \u{1F4EE} TwojaPoczta · http://${HOST}:${PORT}`);
    console.log(`     Konto demo: demo@twojapoczta.com · hasło: demo1234`);
    if (process.env.TP_EXTERNAL === '1') {
      console.log('     Poczta wychodząca na zewnątrz: włączona (TP_EXTERNAL=1)');
      console.log(
        dkimConfigured()
          ? '     DKIM: podpisujemy wychodzące · rekord DNS: npm run dkim'
          : '     DKIM: wyłączone (brak klucza)'
      );
    }
    console.log('');
  });

  let smtp = null;
  if (process.env.TP_SMTP_PORT) {
    smtp = startSmtpServer(db, {
      port: Number(process.env.TP_SMTP_PORT),
      host: process.env.TP_SMTP_HOST ?? '0.0.0.0',
      hostname: process.env.TP_SMTP_HOSTNAME,
    });
  }

  const shutdown = () => {
    smtp?.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
