// Static file serving for public/ with clean URLs, safe path resolution and caching.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Clean URLs for top-level pages.
const PAGES = {
  '/': 'index.html',
  '/app': 'app.html',
  '/logowanie': 'logowanie.html',
  '/rejestracja': 'rejestracja.html',
};

function cacheControl(filePath) {
  if (filePath.includes(`${path.sep}fonts${path.sep}`)) return 'public, max-age=31536000, immutable';
  if (filePath.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return notFound(res, root);
    }
    if (decoded.includes('\0')) return notFound(res, root);

    const relative = PAGES[decoded] ?? decoded.replace(/^\/+/, '');
    const filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return notFound(res, root);
    }

    const found = await resolveFile(filePath);
    if (!found) return notFound(res, root);

    send(req, res, found, 200);
  };
}

async function resolveFile(filePath) {
  const candidates = [filePath, `${filePath}.html`, path.join(filePath, 'index.html')];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: candidate, size: info.size };
    } catch {
      // keep trying candidates
    }
  }
  return null;
}

async function notFound(res, root) {
  const fallback = await resolveFile(path.join(root, '404.html'));
  if (fallback) return send(null, res, fallback, 404);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404: nie znaleziono');
}

function send(req, res, file, status) {
  const type = MIME[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': file.size,
    'Cache-Control': cacheControl(file.path),
  });
  if (req?.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
}
