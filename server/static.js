import { createReadStream, promises as fs } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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

// Build id: a hash of every app file. App code is served under /v/<id>/..., so a deploy
// changes every script/style URL and no browser or CDN cache can hand out an old copy.
let build = null;
let buildKey = '';

async function appFiles() {
  return [...await listFiles(CLIENT, '/'), ...await listFiles(SHARED, '/shared/'), '/sw.js'].sort();
}

async function currentBuild() {
  const files = await appFiles();
  const stats = await Promise.all(files.map((f) => fs.stat(resolvePath(f))));
  const key = files.map((f, i) => `${f}:${stats[i].size}:${stats[i].mtimeMs}`).join('|');
  if (build && key === buildKey) return build;
  const hash = createHash('sha1');
  for (const f of files) hash.update(f).update(await fs.readFile(resolvePath(f)));
  const v = hash.digest('hex').slice(0, 10);
  const versioned = (f) => (/^\/(js|css|shared)\//.test(f) ? `/v/${v}${f}` : f);
  const precache = JSON.stringify({
    version: v,
    files: ['/', ...files.filter((f) => f !== '/index.html' && f !== '/sw.js').map(versioned)],
  });
  const importMap = JSON.stringify({ imports: { '/shared/': `/v/${v}/shared/` } });
  const html = (await fs.readFile(join(CLIENT, 'index.html'), 'utf8'))
    .replace('href="/css/main.css"', `href="/v/${v}/css/main.css"`)
    .replace('src="/js/main.js"', `src="/v/${v}/js/main.js"`)
    .replace('</head>', `<script type="importmap">${importMap}</script>\n</head>`);
  const sw = (await fs.readFile(join(CLIENT, 'sw.js'), 'utf8')).replace(/const CACHE = '[^']*';/, `const CACHE = 'ludo-${v}';`);
  build = { v, precache: Buffer.from(precache), html: Buffer.from(html), sw: Buffer.from(sw) };
  buildKey = key;
  return build;
}

function sendBuffer(req, res, type, body, extra = {}) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = url.pathname;
  let immutable = false;
  const ver = /^\/v\/([0-9a-f]{6,16})(\/(?:js|css|shared)\/.*)$/.exec(path);
  if (ver) {
    path = ver[2];
    // An old page asking for an old version gets today's file, just not cached for good.
    immutable = ver[1] === (build || await currentBuild()).v;
  }
  if (path === '/precache.json') return sendBuffer(req, res, MIME['.json'], (await currentBuild()).precache);
  if (path === '/sw.js') return sendBuffer(req, res, MIME['.js'], (await currentBuild()).sw, { 'Service-Worker-Allowed': '/' });
  if (path === '/' || path === '/index.html' || /^\/r\/[A-Za-z0-9]{4,8}\/?$/.test(path)) {
    return sendBuffer(req, res, MIME['.html'], (await currentBuild()).html);
  }
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
  if (immutable) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  else if (ext === '.woff2' || ext === '.png') headers['Cache-Control'] = 'public, max-age=604800';
  else headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
