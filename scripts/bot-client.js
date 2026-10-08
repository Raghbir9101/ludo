// Headless WebSocket player used for manual testing and the load test.
// Usage: node scripts/bot-client.js CODE [url]
import WebSocket from 'ws';
import { chooseMove } from '../shared/botcore.js';
import { applyEvents } from '../shared/engine.js';

export function playClient({ url, name, code, create, onRoom, onGameOver, onMessage, thinkMs = 0, autoReady = true }) {
  const ws = new WebSocket(url);
  const c = { ws, state: null, seat: -1, seq: 0, code, latencies: [], pendingAt: 0, done: false, errors: 0, errorCodes: {}, resyncs: 0, openedAt: performance.now(), welcomeMs: 0 };
  const think = typeof thinkMs === 'function' ? thinkMs : () => thinkMs;
  const send = (m) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  c.send = send;
  const act = () => {
    const st = c.state;
    if (!st || st.over || st.turn !== c.seat) return;
    setTimeout(() => {
      if (c.state !== st) return;
      c.pendingAt = performance.now();
      if (st.phase === 'roll') send({ t: 'roll' });
      else {
        const m = chooseMove(st, 'medium');
        if (m) send({ t: 'move', seat: m.seat, token: m.token });
      }
    }, think());
  };
  ws.on('open', () => {
    send({ t: 'hello', name });
    if (create) send({ t: 'create', opts: create });
    else send({ t: 'join', code });
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    onMessage?.(m, c);
    if (m.t === 'welcome') c.welcomeMs = performance.now() - c.openedAt;
    else if (m.t === 'error') {
      c.errors++;
      c.errorCodes[m.code] = (c.errorCodes[m.code] || 0) + 1;
    }
    else if (m.t === 'room') {
      c.code = m.room.code;
      c.seat = m.room.you.seat;
      const me = m.room.seats[c.seat];
      if (autoReady && me && !me.ready && !m.room.you.host) send({ t: 'ready', on: true });
      onRoom?.(m.room, c);
    } else if (m.t === 'game') {
      c.state = m.state;
      c.seq = m.seq;
      c.seat = m.you.seat;
      act();
    } else if (m.t === 'meta') {
      if (m.seq > c.seq) c.seq = m.seq;
    } else if (m.t === 'ev') {
      if (c.pendingAt) {
        c.latencies.push(performance.now() - c.pendingAt);
        c.pendingAt = 0;
      }
      if (m.seq <= c.seq) return;
      if (m.seq !== c.seq + 1) {
        c.resyncs++;
        send({ t: 'resync' });
        return;
      }
      c.seq = m.seq;
      c.state = applyEvents(c.state, m.events);
      if (c.state.over && !c.done) {
        c.done = true;
        onGameOver?.(c);
      }
      act();
    }
  });
  return c;
}

if (process.argv[1] && process.argv[1].endsWith('bot-client.js')) {
  const code = process.argv[2];
  const url = process.argv[3] || 'ws://localhost:8080/ws';
  playClient({
    url, name: 'NodeBot', code, thinkMs: 700,
    onRoom: (r) => console.log('room', r.code, 'seat', r.you.seat, 'phase', r.phase),
    onGameOver: () => { console.log('game over'); process.exit(0); },
    onMessage: (m) => { if (m.t === 'error') console.log('error', m.code); },
  });
}
