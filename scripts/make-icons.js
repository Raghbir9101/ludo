// Renders the app icons from client/dev/icon.html into client/icons with headless Chrome
// (no npm dependencies). Start the server first, then: npm run icons
// Env: ICON_URL (default http://localhost:8080/dev/icon.html), CHROME_PATH (browser binary).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'icons');
const URL_ = process.env.ICON_URL || 'http://localhost:8080/dev/icon.html';
const PORT = 9335;
const TARGETS = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['maskable-192.png', 192, 'maskable'],
  ['maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'full'],
  ['favicon-32.png', 32, 'any'],
  ['favicon-16.png', 16, 'any'],
];

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = join(tmpdir(), `ludo-icons-${process.pid}`);
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank']);

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

  await cdp('Page.navigate', { url: URL_ });
  for (let i = 0; i < 50 && !(await evaluate('window.iconReady === true')); i++) await sleep(200);
  mkdirSync(OUT, { recursive: true });
  for (const [name, size, kind] of TARGETS) {
    const data = await evaluate(`window.iconData(${size}, '${kind}')`);
    if (!data) throw new Error(`could not render ${name} (is the server running at ${URL_}?)`);
    writeFileSync(join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', name);
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
