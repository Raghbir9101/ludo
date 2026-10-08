// HTTP static server + WebSocket game server.
import './env.js';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { serveStatic } from './static.js';
import { RoomManager } from './rooms.js';
import { createStore, userPic } from './store.js';
import { Auth } from './auth.js';
import { Social } from './social.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || undefined; // undefined = dual-stack (IPv4 + IPv6)
const HEARTBEAT_MS = 25_000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

export function createServer(cfg = {}, { store = createStore(), env = process.env } = {}) {
  const auth = new Auth({ store, env });
  const manager = new RoomManager({
    animScale: process.env.ANIM_SCALE != null ? Number(process.env.ANIM_SCALE) : 1,
    timerScale: process.env.TIMER_SCALE != null ? Number(process.env.TIMER_SCALE) : 1,
    minHumans: process.env.MIN_HUMANS != null ? Number(process.env.MIN_HUMANS) : 2,
    ...(process.env.BUCKET_RATE ? { bucketRate: Number(process.env.BUCKET_RATE), bucketSize: Number(process.env.BUCKET_SIZE || process.env.BUCKET_RATE) } : {}),
    ...cfg,
  });
  const social = new Social({ store, manager });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        rooms: manager.rooms.size,
        conns: manager.conns.size,
        games: manager.stats,
        rssMB: Math.round(mem.rss / 1048576),
        heapMB: Math.round(mem.heapUsed / 1048576),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        uptimeS: Math.round(process.uptime()),
        online: social.online.size,
        store: store.kind,
      }));
    }
    if (await auth.handle(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const conn = {
      send(obj) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      },
      close() {
        try { ws.close(4000, 'closed'); } catch { /* already closed */ }
      },
    };
    // Messages that arrive while the login cookie is being checked are held, then replayed.
    let pending = [];
    let closed = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (pending) { if (pending.length < 20) pending.push(data.toString()); return; }
      manager.handleRaw(conn, data.toString());
    });
    ws.on('close', () => {
      closed = true;
      if (!pending) manager.disconnect(conn);
    });
    ws.on('error', () => {});
    auth.userFromReq(req).then((u) => {
      if (closed) return;
      conn.user = u ? { id: u._id, name: u.name, pic: userPic(u) } : null;
      manager.connect(conn);
      const q = pending;
      pending = null;
      for (const raw of q) manager.handleRaw(conn, raw);
    });
  });

  // Ping every 25s so proxies (Cloudflare drops idle sockets after ~100s) keep the socket open.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(() => manager.sweep(), 10 * 60_000);
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
  });

  return { server, wss, manager, auth, social, store };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { server } = createServer();
  server.listen(PORT, HOST, () => console.log(`Ludo server listening on http://localhost:${PORT}`));
  const shutdown = () => {
    console.log('Shutting down');
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
