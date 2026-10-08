// Load test: N concurrent rooms, each with 4 headless WebSocket players that create/join,
// ready up and play full games against the real server.
//
//   npm run loadtest                       # 50 rooms, accelerated (spawns its own server)
//   npm run loadtest -- --realtime --duration 60
//   npm run loadtest -- --url ws://host:8080/ws --rooms 20
//
// Accelerated mode scales server animation waits down (ANIM_SCALE) and plays instantly, so
// whole games finish in seconds and the server is driven at many times normal message rates.
// Realtime mode uses normal server pacing and human-like think times for a fixed duration.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { playClient } from './bot-client.js';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const ROOMS = Number(arg('rooms', 50));
const PLAYERS = Number(arg('players', 4));
const REALTIME = !!arg('realtime', false);
const DURATION = Number(arg('duration', REALTIME ? 60 : 300)) * 1000;
const PORT = Number(arg('port', 8099));
const EXTERNAL = arg('url', null);
const URL_WS = EXTERNAL || `ws://127.0.0.1:${PORT}/ws`;
const HTTP = URL_WS.replace(/^ws/, 'http').replace(/\/ws$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (n) => n.toFixed(1);

async function startServer() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ANIM_SCALE: REALTIME ? '1' : '0.01', TIMER_SCALE: '1' };
  // Accelerated clients act instantly, far above human rates; lift the per-socket limit.
  if (!REALTIME) Object.assign(env, { BUCKET_RATE: '1000', BUCKET_SIZE: '1000' });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (/listening/.test(String(d))) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  });
  return child;
}

async function health() {
  const res = await fetch(`${HTTP}/healthz`);
  return res.json();
}

function startRoom(idx, stats) {
  return new Promise((resolve) => {
    const clients = [];
    const think = REALTIME ? () => 300 + Math.random() * 900 : () => 0;
    let started = false;
    let finished = false;
    const t0 = performance.now();
    const done = (ok) => {
      if (finished) return;
      finished = true;
      resolve({ ok, ms: performance.now() - t0, clients });
    };
    const host = playClient({
      url: URL_WS, name: `H${idx}`, thinkMs: think,
      create: { n: PLAYERS, timer: 30, autoMove: false },
      onRoom: (r, c) => {
        if (clients.length === 1) {
          for (let k = 1; k < PLAYERS; k++) {
            const p = playClient({ url: URL_WS, name: `P${idx}-${k}`, code: r.code, thinkMs: think, onGameOver: () => done(true) });
            clients.push(p);
            stats.clients.push(p);
          }
        }
        const others = r.seats.filter((s) => s.kind === 'human' && !s.host);
        if (!started && others.length === PLAYERS - 1 && others.every((s) => s.ready)) {
          started = true;
          stats.startedAt.push(performance.now() - t0);
          c.send({ t: 'start' });
        }
      },
      onGameOver: () => done(true),
    });
    clients.push(host);
    stats.clients.push(host);
  });
}

async function main() {
  const server = EXTERNAL ? null : await startServer();
  console.log(`Load test: ${ROOMS} rooms x ${PLAYERS} players (${ROOMS * PLAYERS} sockets), ${REALTIME ? `realtime for ${DURATION / 1000}s` : 'accelerated, full games'}`);
  console.log(`Server: ${URL_WS}${server ? ' (spawned)' : ''}`);

  const stats = { startedAt: [], clients: [] };
  const samples = [];
  let last = await health();
  let lastAt = performance.now();
  const sampler = setInterval(async () => {
    try {
      const h = await health();
      const now = performance.now();
      samples.push({ ...h, cpuPct: ((h.cpuMs - last.cpuMs) / (now - lastAt)) * 100 });
      last = h;
      lastAt = now;
    } catch { /* server busy */ }
  }, 1000);

  const t0 = performance.now();
  const rooms = [];
  for (let i = 0; i < ROOMS; i++) {
    rooms.push(startRoom(i, stats));
    await sleep(20); // stagger connects like real arrivals
  }
  const all = await Promise.race([
    Promise.all(rooms),
    sleep(DURATION).then(() => null),
  ]);
  const wall = performance.now() - t0;
  clearInterval(sampler);
  const finalHealth = await health();

  const results = all || [];
  const live = stats.clients;
  const lat = live.flatMap((c) => c.latencies);
  const welcome = live.map((c) => c.welcomeMs).filter(Boolean);
  const errors = live.reduce((a, c) => a + c.errors, 0);
  const resyncs = live.reduce((a, c) => a + c.resyncs, 0);
  const cpu = samples.map((s) => s.cpuPct);
  const rss = samples.map((s) => s.rssMB);

  const report = [
    `Rooms finished:       ${results.filter((r) => r.ok).length}/${ROOMS}${all ? '' : ' (duration limit reached)'}`,
    `Wall time:            ${fmt(wall / 1000)} s`,
    results.length ? `Game length:          median ${fmt(pct(results.map((r) => r.ms), 50) / 1000)} s, max ${fmt(Math.max(...results.map((r) => r.ms)) / 1000)} s` : null,
    `Actions measured:     ${lat.length} (${fmt(lat.length / (wall / 1000))} per second)`,
    `Action -> broadcast:  p50 ${fmt(pct(lat, 50))} ms, p95 ${fmt(pct(lat, 95))} ms, p99 ${fmt(pct(lat, 99))} ms, max ${fmt(Math.max(0, ...lat))} ms`,
    `Connect -> welcome:   p50 ${fmt(pct(welcome, 50))} ms, p95 ${fmt(pct(welcome, 95))} ms`,
    `Server CPU:           avg ${fmt(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length))}%, peak ${fmt(Math.max(0, ...cpu))}% of one core`,
    `Server memory (RSS):  peak ${Math.max(0, ...rss)} MB`,
    `Server messages:      ${finalHealth.games.messages} received, ${finalHealth.games.dropped} rate-limited, ${finalHealth.games.gamesFinished} games finished`,
    `Client errors:        ${errors}${errors ? ` (${Object.entries(live.reduce((a, c) => { for (const [k, v] of Object.entries(c.errorCodes)) a[k] = (a[k] || 0) + v; return a; }, {})).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}, seq resyncs: ${resyncs}`,
  ].filter(Boolean).join('\n');
  console.log(`\n${report}`);

  for (const c of live) c.ws.close();
  server?.kill();
  process.exit(errors || (all && results.some((r) => !r.ok)) ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
