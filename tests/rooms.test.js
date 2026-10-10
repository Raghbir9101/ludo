import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, CODE_ALPHABET } from '../server/rooms.js';
import { applyEvents } from '../shared/engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeConn(mgr, name = 'P') {
  const c = {
    inbox: [],
    closed: false,
    send(m) { this.inbox.push(JSON.parse(JSON.stringify(m))); },
    close() { this.closed = true; },
    last(t) { return [...this.inbox].reverse().find((m) => m.t === t); },
    msg(obj) { mgr.handleRaw(this, JSON.stringify(obj)); },
  };
  mgr.connect(c);
  c.msg({ t: 'hello', name });
  c.token = c.last('welcome').session;
  return c;
}

const managers = [];
after(() => managers.forEach((m) => m.shutdown()));

function setup(cfg = {}) {
  const m = new RoomManager({ animScale: 0, holdMs: 50, emptyRoomMs: 80, bucketSize: 1000, bucketRate: 1000, chatGapMs: 0, ...cfg });
  managers.push(m);
  return m;
}

test('create gives a 6-char code with no ambiguous characters', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'Ann');
  a.msg({ t: 'create', opts: { n: 6, timer: 15 } });
  const room = a.last('room').room;
  assert.equal(room.code.length, 6);
  for (const ch of room.code) assert.ok(CODE_ALPHABET.includes(ch));
  assert.ok(!/[01OI]/.test(room.code));
  assert.equal(room.seats.length, 6);
  assert.equal(room.you.host, true);
  assert.equal(room.seats[5].name, 'Ann');
});

test('join errors: not found, full, started (with spectate)', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4 } });
  const code = a.last('room').room.code;
  const x = fakeConn(mgr, 'X');
  x.msg({ t: 'join', code: 'ZZZZZZ' });
  assert.equal(x.last('error').code, 'notFound');
  const others = [1, 2, 3].map((i) => fakeConn(mgr, `P${i}`));
  others.forEach((c) => c.msg({ t: 'join', code }));
  x.msg({ t: 'join', code });
  assert.equal(x.last('error').code, 'full');
  others.forEach((c) => c.msg({ t: 'ready', on: true }));
  a.msg({ t: 'start' });
  assert.ok(a.last('game'));
  const y = fakeConn(mgr, 'Y');
  y.msg({ t: 'join', code });
  assert.equal(y.last('error').code, 'started');
  y.msg({ t: 'join', code, spectate: true });
  assert.equal(y.last('game').you.spectator, true);
  y.msg({ t: 'roll' });
  assert.equal(y.last('error').code, 'spectator');
});

test('start requires 2 humans and everyone ready; empty seats become bots', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4 } });
  const code = a.last('room').room.code;
  a.msg({ t: 'start' });
  assert.equal(a.last('error').code, 'needPlayers');
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  a.msg({ t: 'start' });
  assert.equal(a.last('error').code, 'notReady');
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'start' });
  const g = b.last('game');
  assert.ok(g);
  assert.equal(g.players.filter((p) => p.bot).length, 2);
  assert.ok(g.state.players.every((p) => p.active));
});

test('team rooms: both teams need players; bots fill partners; teams follow seat parity', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, teamMode: true } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  const r = a.last('room').room;
  const aSeat = r.you.seat;
  const bSeat = b.last('room').room.you.seat;
  if (aSeat % 2 !== bSeat % 2) a.msg({ t: 'moveSeat', from: bSeat, to: (aSeat + 2) % 4 });
  a.msg({ t: 'setFill', on: false });
  a.msg({ t: 'start' });
  assert.equal(a.last('error').code, 'teams');
  a.msg({ t: 'setFill', on: true });
  a.msg({ t: 'start' });
  const g = a.last('game');
  assert.ok(g, 'starts once bots fill the other team');
  assert.ok(g.state.opts.teamMode);
  g.state.players.forEach((p) => assert.equal(p.team, p.seat % 2));
});

test('empty seats still get their own distinct colors (2 humans, team mode, no bots)', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, teamMode: true } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'setFill', on: false });
  const r = a.last('room').room;
  const aSeat = r.you.seat, bSeat = b.last('room').room.you.seat;
  if (r.teams[aSeat] === r.teams[bSeat]) a.msg({ t: 'setTeam', seat: bSeat, team: 1 - r.teams[aSeat] });
  a.msg({ t: 'start' });
  const g = a.last('game');
  assert.ok(g, 'game started');
  assert.equal(g.state.players.filter((p) => p.active).length, 2);
  const colors = g.state.players.map((p) => p.color);
  assert.equal(new Set(colors).size, 4, `colors ${colors}`);
  assert.ok(colors.every((c) => c >= 0 && c < 8));
  assert.equal(g.state.players[aSeat].color, r.seats[aSeat].color);
  assert.equal(g.state.players[bSeat].color, r.seats[bSeat].color);
});

test('host can kick, move seats, toggle bots; colors are unique', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4 } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  const bSeat = b.last('room').room.you.seat;
  const aColor = a.last('room').room.seats[3].color;
  b.msg({ t: 'setColor', color: aColor });
  assert.equal(b.last('error').code, 'colorTaken');
  b.msg({ t: 'setColor', color: 6 });
  assert.equal(a.last('room').room.seats[bSeat].color, 6);
  a.msg({ t: 'moveSeat', from: bSeat, to: 2 });
  assert.equal(a.last('room').room.seats[2].name, 'B');
  assert.equal(b.last('room').room.you.seat, 2);
  a.msg({ t: 'setBot', seat: 1, on: true });
  assert.equal(a.last('room').room.seats[1].kind, 'bot');
  b.msg({ t: 'kick', seat: 3 });
  assert.equal(b.last('error').code, 'notHost');
  a.msg({ t: 'kick', seat: 2 });
  assert.equal(b.last('left').reason, 'kicked');
  assert.equal(a.last('room').room.seats[2].kind, 'empty');
  b.msg({ t: 'join', code });
  assert.equal(b.last('error').code, 'kicked');
});

test('server validates turns and moves; events replay to the same state', async () => {
  const mgr = setup({ autoMoveDelay: 0 });
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, timer: 0, autoMove: false } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'setFill', on: false });
  a.msg({ t: 'start' });
  const g0 = a.last('game');
  let mirror = g0.state;
  let seq = g0.seq;
  const room = mgr.rooms.get(code);
  const conns = { [a.last('game').you.seat]: a, [b.last('game').you.seat]: b };
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 5000) {
    const st = room.game;
    const me = conns[st.turn];
    const other = conns[st.turn === 3 ? 0 : 3] || b;
    other.msg({ t: 'roll' });
    if (st.phase === 'roll') me.msg({ t: 'roll' });
    else {
      me.msg({ t: 'move', seat: 9, token: 9 });
      assert.equal(me.last('error').code, 'illegalMove');
      me.msg({ t: 'move', seat: st.legal[0].seat, token: st.legal[0].token });
    }
    await sleep(0);
  }
  for (const m of a.inbox) {
    if (m.t === 'ev' && m.seq > seq) {
      assert.equal(m.seq, seq + 1, 'no gaps in seq');
      seq = m.seq;
      mirror = applyEvents(mirror, m.events);
    }
  }
  assert.equal(room.phase, 'over');
  assert.deepEqual(mirror, room.game);
});

test('reconnect with session restores the seat; seat is held then given to a bot', async () => {
  const mgr = setup({ holdMs: 60 });
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, timer: 0 } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'start' });
  const bSeat = b.last('game').you.seat;
  mgr.disconnect(b);
  assert.equal(a.last('meta').players[bSeat].connected, false);
  const b2 = { inbox: [], send(m) { this.inbox.push(m); }, close() {}, last(t) { return [...this.inbox].reverse().find((m) => m.t === t); } };
  mgr.connect(b2);
  mgr.handleRaw(b2, JSON.stringify({ t: 'hello', session: b.token, name: 'B' }));
  assert.equal(b2.last('game').you.seat, bSeat, 'rejoined automatically');
  mgr.disconnect(b2);
  await sleep(120);
  const room = mgr.rooms.get(code);
  assert.equal(room.seats[bSeat].kind, 'bot');
});

function rawConn(mgr, user) {
  const c = { inbox: [], user, send(m) { this.inbox.push(JSON.parse(JSON.stringify(m))); }, close() { this.closed = true; }, last(t) { return [...this.inbox].reverse().find((m) => m.t === t); } };
  mgr.connect(c);
  return c;
}

function startedGame(mgr, bUser) {
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, timer: 0 } });
  const code = a.last('room').room.code;
  const b = rawConn(mgr, bUser);
  mgr.handleRaw(b, JSON.stringify({ t: 'hello', name: 'B' }));
  mgr.handleRaw(b, JSON.stringify({ t: 'join', code }));
  mgr.handleRaw(b, JSON.stringify({ t: 'ready', on: true }));
  a.msg({ t: 'start' });
  return { a, b, code, bSeat: b.last('game').you.seat };
}

test('signed-in player gets the seat back from another device (no session token)', () => {
  const mgr = setup({ holdMs: 60, accountHoldMs: 5000 });
  const user = { id: 'u1', name: 'Raghbir', pic: null };
  const { b, bSeat } = startedGame(mgr, user);
  mgr.disconnect(b);
  const phone = rawConn(mgr, user);
  mgr.handleRaw(phone, JSON.stringify({ t: 'hello', name: 'B' }));
  assert.ok(phone.last('welcome').room, 'welcome names the room');
  assert.equal(phone.last('game').you.seat, bSeat);
});

test('opening the game on a second device moves the seat there', () => {
  const mgr = setup();
  const user = { id: 'u2', name: 'Sam', pic: null };
  const { b, bSeat } = startedGame(mgr, user);
  const tab = rawConn(mgr, user);
  mgr.handleRaw(tab, JSON.stringify({ t: 'hello', name: 'B' }));
  assert.equal(tab.last('game').you.seat, bSeat);
  assert.equal(b.last('left').reason, 'elsewhere');
});

test('signed-in seats are held longer than guest seats', async () => {
  const mgr = setup({ holdMs: 30, accountHoldMs: 400 });
  const { b, bSeat, code } = startedGame(mgr, { id: 'u3', name: 'Ann', pic: null });
  mgr.disconnect(b);
  await sleep(120);
  assert.equal(mgr.rooms.get(code).seats[bSeat].kind, 'human', 'still held');
});

test('after a bot takes over, the same account can reclaim the seat', async () => {
  const mgr = setup({ accountHoldMs: 40 });
  const user = { id: 'u4', name: 'Kay', pic: null };
  const { a, b, bSeat, code } = startedGame(mgr, user);
  mgr.disconnect(b);
  await sleep(100);
  const room = mgr.rooms.get(code);
  assert.equal(room.seats[bSeat].kind, 'bot');
  const back = rawConn(mgr, user);
  mgr.handleRaw(back, JSON.stringify({ t: 'hello', name: 'B' }));
  assert.equal(back.last('game').you.seat, bSeat);
  assert.equal(room.seats[bSeat].kind, 'human');
  assert.equal(room.seats[bSeat].name, 'Kay');
  assert.equal(a.last('meta').players[bSeat].bot, false);
});

test('leaving on purpose gives the seat up for good', () => {
  const mgr = setup();
  const user = { id: 'u5', name: 'Lee', pic: null };
  const { b, bSeat, code } = startedGame(mgr, user);
  mgr.handleRaw(b, JSON.stringify({ t: 'leave' }));
  mgr.disconnect(b);
  const back = rawConn(mgr, user);
  mgr.handleRaw(back, JSON.stringify({ t: 'hello', name: 'B' }));
  assert.equal(back.last('welcome').room, null);
  assert.equal(mgr.rooms.get(code).seats[bSeat].kind, 'bot');
});

test('turn timer: three timeouts mark the player AFK and a bot takes over', async () => {
  const mgr = setup({ timerScale: 0.002, autoMoveDelay: 0 });
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, timer: 15 } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'setFill', on: false });
  a.msg({ t: 'start' });
  const room = mgr.rooms.get(code);
  for (let i = 0; i < 400 && !room.seats.some((s) => s.afk); i++) await sleep(5);
  const afk = room.seats.find((s) => s.afk);
  assert.ok(afk, 'someone went AFK');
  assert.ok(a.inbox.some((m) => m.t === 'timer' && m.seat >= 0));
  assert.ok(a.last('meta').players.some((p) => p.afk));
  const conn = afk.pid === a.pid ? a : b;
  conn.msg({ t: 'here' });
  assert.ok(!room.seats.some((s) => s.afk), 'interaction clears AFK');
  mgr.destroy(room);
});

test('reconnecting during your own turn keeps the running timer', async () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4, timer: 30 } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'setFill', on: false });
  a.msg({ t: 'start' });
  const room = mgr.rooms.get(code);
  for (let i = 0; i < 50 && !room.timerInfo; i++) await sleep(2);
  const info = room.timerInfo;
  assert.ok(info, 'timer running');
  const conn = room.seats[info.seat].pid === a.pid ? a : b;
  mgr.disconnect(conn);
  assert.equal(room.timerInfo, info, 'timer survives disconnect');
  const c2 = { inbox: [], send(m) { this.inbox.push(m); }, close() {}, last(t) { return [...this.inbox].reverse().find((m) => m.t === t); } };
  mgr.connect(c2);
  mgr.handleRaw(c2, JSON.stringify({ t: 'hello', session: conn.token, name: 'X' }));
  assert.equal(room.timerInfo.endsAt, info.endsAt, 'timer not reset on reconnect');
  assert.equal(c2.last('timer').seat, info.seat);
  mgr.destroy(room);
});

test('rooms are destroyed after the last human leaves', async () => {
  const mgr = setup({ emptyRoomMs: 30 });
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4 } });
  const code = a.last('room').room.code;
  a.msg({ t: 'leave' });
  assert.ok(mgr.rooms.has(code));
  await sleep(60);
  assert.ok(!mgr.rooms.has(code));
});

test('rate limiting drops floods', () => {
  const mgr = new RoomManager({ bucketSize: 5, bucketRate: 0.001 });
  managers.push(mgr);
  const c = fakeConn(mgr, 'A');
  for (let i = 0; i < 20; i++) c.msg({ t: 'ping', at: i });
  assert.ok(c.inbox.some((m) => m.code === 'rateLimited'));
  assert.ok(c.inbox.filter((m) => m.t === 'pong').length <= 5);
});

test('quick chat broadcasts fixed phrases only', () => {
  const mgr = setup();
  const a = fakeConn(mgr, 'A');
  a.msg({ t: 'create', opts: { n: 4 } });
  const code = a.last('room').room.code;
  const b = fakeConn(mgr, 'B');
  b.msg({ t: 'join', code });
  a.msg({ t: 'chat', p: 1 });
  assert.equal(b.last('chat').p, 1);
  a.msg({ t: 'chat', text: 'free text' });
  assert.equal(b.inbox.filter((m) => m.t === 'chat').length, 1);
});
