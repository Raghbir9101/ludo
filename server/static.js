import { createReadStream, promises as fs } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT = join(ROOT, 'client');
const SHARED = join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function resolvePath(urlPath) {
  let base = CLIENT;
  let rel = urlPath;
  if (urlPath.startsWith('/shared/')) {
    base = SHARED;
    rel = urlPath.slice('/shared'.length);
  }
  const full = normalize(join(base, decodeURIComponent(rel)));
  if (!full.startsWith(base + sep) && full !== base) return null;
  return full;
}

async function listFiles(dir, prefix) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'dev') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await listFiles(p, `${prefix}${ent.name}/`));
    else if (MIME[extname(ent.name)] && ent.name !== 'sw.js' && ent.name !== 'OFL.txt') out.push(prefix + ent.name);
  }
  return out;
}

let precache = null;
// App-shell file list for the service worker; computed once per server start.
async function precacheList() {
  if (!precache) {
    const files = [...await listFiles(CLIENT, '/'), ...await listFiles(SHARED, '/shared/')]
      .filter((f) => f !== '/index.html');
    precache = JSON.stringify({ version: Date.now().toString(36), files: ['/', ...files] });
  }
  return precache;
}

export async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = url.pathname;
  if (path === '/precache.json') {
    const body = await precacheList();
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    return res.end(body);
  }
  if (path === '/' || /^\/r\/[A-Za-z0-9]{4,8}\/?$/.test(path)) path = '/index.html';
  const file = resolvePath(path);
  if (!file) {
    res.writeHead(400).end('Bad request');
    return;
  }
  let stat;
  try {
    stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const ext = extname(file);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
  };
  if (ext === '.woff2' || ext === '.png') headers['Cache-Control'] = 'public, max-age=604800';
  else headers['Cache-Control'] = 'no-cache';
  if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
