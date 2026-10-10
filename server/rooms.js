// Room lifecycle, seats, lobby actions and the authoritative turn loop.
// Transport-agnostic: a connection is any object with send(obj) and close().
import { randomBytes, randomInt } from 'node:crypto';
import { createGame, roll, move, distinctMoves, rollDie } from './game.js';
import { chooseMove, botThinkMs, animMs } from './bot.js';
import { COLORS, DEFAULT_SEAT_COLORS, QUICK_CHAT, EMOJIS, teamOf, seatColors } from '../shared/rules.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Pip', 'Dot', 'Bix', 'Zuzu', 'Momo', 'Kiki', 'Taro', 'Nova'];
const BOT_AVATAR = '🤖';
const DIFFS = ['easy', 'medium', 'hard'];

export const DEFAULT_CONFIG = {
  holdMs: 60_000,
  emptyRoomMs: 5 * 60_000,
  animScale: 1,
  timerScale: 1,
  minHumans: 2,
  maxRooms: 5000,
  autoMoveDelay: 450,
  chatGapMs: 900,
  bucketSize: 20,
  bucketRate: 10,
};

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

export class RoomManager {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.rooms = new Map();
    this.sessions = new Map();
    this.conns = new Set();
    this.stats = { messages: 0, dropped: 0, roomsCreated: 0, gamesFinished: 0 };
  }

  // ---------- connections ----------
  connect(conn) {
    conn.pid = null;
    conn.session = null;
    conn.room = null;
    conn.spectator = false;
    conn.bucket = this.cfg.bucketSize;
    conn.bucketAt = Date.now();
    conn.drops = 0;
    conn.lastChat = 0;
    this.conns.add(conn);
  }

  allow(conn) {
    const now = Date.now();
    conn.bucket = Math.min(this.cfg.bucketSize, conn.bucket + ((now - conn.bucketAt) / 1000) * this.cfg.bucketRate);
    conn.bucketAt = now;
    if (conn.bucket < 1) {
      conn.drops++;
      this.stats.dropped++;
      if (conn.drops === 1) conn.send({ t: 'error', code: 'rateLimited', msg: 'Slow down!' });
      if (conn.drops > 200) conn.close();
      return false;
    }
    conn.bucket -= 1;
    return true;
  }

  handleRaw(conn, raw) {
    if (!this.allow(conn)) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return conn.send({ t: 'error', code: 'badMessage' });
    }
    if (!msg || typeof msg.t !== 'string') return conn.send({ t: 'error', code: 'badMessage' });
    this.stats.messages++;
    try {
      this.handle(conn, msg);
    } catch (err) {
      conn.send({ t: 'error', code: 'serverError', msg: 'Something went wrong' });
      console.error('handler error', msg.t, err);
    }
  }

  handle(conn, msg) {
    if (msg.t === 'hello') return this.hello(conn, msg);
    if (!conn.pid) return conn.send({ t: 'error', code: 'noHello' });
    if (this.social?.handles(msg.t)) {
      return this.social.handle(conn, msg).catch((err) => {
        console.error('social handler error', msg.t, err);
        conn.send({ t: 'error', code: 'serverError', msg: 'Something went wrong' });
      });
    }
    const room = conn.room;
    switch (msg.t) {
      case 'create': return this.create(conn, msg.opts || {});
      case 'join': return this.join(conn, clean(msg.code, 6).toUpperCase(), !!msg.spectate);
      case 'leave': return this.leave(conn);
      case 'profile': return this.profile(conn, msg);
      case 'resync': return room && this.sendFull(room, conn);
      case 'ping': return conn.send({ t: 'pong', at: msg.at });
    }
    if (!room) return conn.send({ t: 'error', code: 'notInRoom' });
    if (conn.spectator) return conn.send({ t: 'error', code: 'spectator', msg: 'Spectators are read-only' });
    switch (msg.t) {
      case 'setColor': return this.setColor(room, conn, msg.color);
      case 'ready': return this.setReady(room, conn, !!msg.on);
      case 'kick': return this.kick(room, conn, msg.seat);
      case 'moveSeat': return this.moveSeat(room, conn, msg.from, msg.to);
      case 'setTeam': return this.setTeam(room, conn, msg.seat, msg.team);
      case 'shuffleSeats': return this.shuffleSeats(room, conn);
      case 'makeHost': return this.makeHost(room, conn, msg.seat);
      case 'setBot': return this.setBot(room, conn, msg.seat, !!msg.on);
      case 'setFill': return this.hostSet(room, conn, () => { room.fillBots = !!msg.on; });
      case 'setDifficulty': return this.hostSet(room, conn, () => { if (DIFFS.includes(msg.d)) room.difficulty = msg.d; });
      case 'start': return this.start(room, conn);
      case 'roll': return this.humanAct(room, conn, { t: 'roll' });
      case 'move': return this.humanAct(room, conn, { t: 'move', seat: msg.seat | 0, token: msg.token | 0 });
      case 'here': return this.markActive(room, conn);
      case 'chat': return this.chat(room, conn, msg);
      case 'backToLobby': return this.backToLobby(room);
      default: return conn.send({ t: 'error', code: 'unknownType' });
    }
  }

  hello(conn, msg) {
    const uid = conn.user?.id ?? null;
    let sess = msg.session && this.sessions.get(String(msg.session));
    // A session that belongs to another account (sign-out / switch) is not reused.
    if (sess && sess.uid && sess.uid !== uid) sess = null;
    if (!sess) {
      const token = randomBytes(18).toString('base64url');
      sess = { token, pid: randomBytes(6).toString('hex'), roomCode: null, conn: null };
      this.sessions.set(token, sess);
    }
    if (sess.conn && sess.conn !== conn) {
      const old = sess.conn;
      sess.conn = null;
      if (old.room) this.detach(old, false);
      old.send({ t: 'left', reason: 'elsewhere' });
      old.pid = null;
      old.close();
    }
    sess.conn = conn;
    sess.uid = uid;
    sess.name = conn.user?.name || clean(msg.name, 14) || 'Player';
    sess.avatar = clean(msg.avatar, 8) || '🙂';
    sess.pic = conn.user?.pic || null;
    conn.pid = sess.pid;
    conn.session = sess;
    conn.send({ t: 'welcome', session: sess.token, pid: sess.pid, room: sess.roomCode, user: conn.user || null });
    this.social?.connected(conn).catch((err) => console.error('presence error', err));
    if (sess.roomCode && this.rooms.has(sess.roomCode)) {
      const room = this.rooms.get(sess.roomCode);
      const si = this.seatOf(room, conn.pid);
      if (si >= 0) this.attach(room, conn, si);
      else sess.roomCode = null;
    }
  }

  profile(conn, msg) {
    const s = conn.session;
    s.name = clean(msg.name, conn.user ? 20 : 14) || s.name;
    s.avatar = clean(msg.avatar, 8) || s.avatar;
    if (conn.user) this.social?.rename(conn, s.name).catch((err) => console.error('rename error', err));
    const room = conn.room;
    if (room) {
      const si = this.seatOf(room, conn.pid);
      if (si >= 0) {
        room.seats[si].name = s.name;
        room.seats[si].avatar = s.avatar;
        this.broadcastRoomOrMeta(room);
      }
    }
  }

  disconnect(conn) {
    this.conns.delete(conn);
    if (conn.session?.conn === conn) conn.session.conn = null;
    if (conn.room) this.detach(conn, true);
    this.social?.disconnected(conn);
  }

  presence(room) {
    if (!this.social) return;
    for (const c of this.members(room)) this.social.changed(c);
  }

  // Drop sessions that are idle and not attached to a room.
  sweep(maxIdleMs = 60 * 60_000) {
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (s.conn || (s.roomCode && this.rooms.has(s.roomCode))) { s.seen = now; continue; }
      if (!s.seen) s.seen = now;
      else if (now - s.seen > maxIdleMs) this.sessions.delete(token);
    }
  }

  // ---------- rooms ----------
  newCode() {
    for (let i = 0; i < 1000; i++) {
      let c = '';
      for (let j = 0; j < 6; j++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('no free room codes');
  }

  create(conn, o) {
    if (this.rooms.size >= this.cfg.maxRooms) return conn.send({ t: 'error', code: 'serverFull', msg: 'Server is full, try again soon' });
    if (conn.room) this.leave(conn);
    const n = [4, 6, 8].includes(o.n) ? o.n : 4;
    const opts = {
      n,
      teamMode: !!o.teamMode,
      timer: [0, 15, 30].includes(o.timer) ? o.timer : 30,
      quickMode: [0, 1, 2].includes(o.quickMode) ? o.quickMode : 0,
      blockades: !!o.blockades,
      captureToEnterHome: !!o.captureToEnterHome,
      assist: o.assist !== false,
      autoMove: o.autoMove !== false,
    };
    const room = {
      code: this.newCode(), opts, phase: 'lobby', host: conn.pid, seq: 0,
      seats: Array.from({ length: n }, () => emptySeat()),
      teams: Array.from({ length: n }, (_, i) => teamOf(i)),
      spectators: new Set(), conns: new Set(), game: null, fillBots: true, difficulty: 'medium',
      banned: new Set(), timers: {}, autoPlaySeat: -1, createdAt: Date.now(),
    };
    this.rooms.set(room.code, room);
    this.stats.roomsCreated++;
    const si = this.seatOrder(n).find((s) => room.seats[s].kind === 'empty');
    this.takeSeat(room, si, conn);
    this.attach(room, conn, si);
  }

  seatOrder(n) {
    const order = [n - 1];
    for (let s = 0; s < n - 1; s++) order.push(s);
    return order;
  }

  takeSeat(room, si, conn) {
    const taken = new Set(room.seats.filter((s, i) => i !== si && s.kind !== 'empty').map((s) => s.color));
    const pref = DEFAULT_SEAT_COLORS[room.opts.n][si];
    const color = taken.has(pref) ? COLORS.find((c) => !taken.has(c.id)).id : pref;
    clearTimeout(room.seats[si].discTimer);
    room.seats[si] = {
      kind: 'human', pid: conn.pid, name: conn.session.name, avatar: conn.session.avatar, color,
      uid: conn.session.uid, pic: conn.session.pic,
      ready: false, connected: true, afk: false, timeouts: 0, discTimer: null, autoBot: false,
    };
    conn.session.roomCode = room.code;
  }

  join(conn, code, spectate) {
    const room = this.rooms.get(code);
    if (!room) return conn.send({ t: 'error', code: 'notFound', msg: 'Room not found' });
    if (room.banned.has(conn.pid)) return conn.send({ t: 'error', code: 'kicked', msg: 'You were removed from this room' });
    if (conn.room && conn.room !== room) this.leave(conn);
    const existing = this.seatOf(room, conn.pid);
    if (existing >= 0) return this.attach(room, conn, existing);
    if (spectate) {
      conn.spectator = true;
      conn.room = room;
      room.spectators.add(conn);
      this.cancelEmpty(room);
      this.sendFull(room, conn);
      this.broadcastRoomOrMeta(room);
      this.social?.changed(conn);
      return;
    }
    if (room.phase !== 'lobby') return conn.send({ t: 'error', code: 'started', msg: 'Game already started' });
    let si = this.seatOrder(room.opts.n).find((s) => room.seats[s].kind === 'empty');
    if (si == null) si = room.seats.findIndex((s) => s.kind === 'bot');
    if (si == null || si < 0) return conn.send({ t: 'error', code: 'full', msg: 'Room is full' });
    this.takeSeat(room, si, conn);
    this.attach(room, conn, si);
  }

  attach(room, conn, si) {
    conn.room = room;
    conn.spectator = false;
    room.conns.add(conn);
    const seat = room.seats[si];
    clearTimeout(seat.discTimer);
    seat.discTimer = null;
    seat.connected = true;
    seat.name = conn.session.name;
    seat.avatar = conn.session.avatar;
    seat.uid = conn.session.uid;
    seat.pic = conn.session.pic;
    conn.session.roomCode = room.code;
    this.cancelEmpty(room);
    this.broadcastRoomOrMeta(room, conn);
    this.sendFull(room, conn);
    this.social?.changed(conn);
    if (room.phase === 'playing') {
      const mine = room.game.turn === si;
      if (!room.timers.turn && (mine || !room.timers.act)) this.scheduleNext(room, []);
    }
  }

  // Connection went away (disconnect) or left elsewhere. Seat is held for holdMs.
  detach(conn, hold) {
    const room = conn.room;
    conn.room = null;
    if (!room) return;
    room.conns.delete(conn);
    this.social?.changed(conn);
    if (conn.spectator) {
      room.spectators.delete(conn);
      conn.spectator = false;
      this.broadcastRoomOrMeta(room);
      this.checkEmpty(room);
      return;
    }
    const si = this.seatOf(room, conn.pid);
    if (si < 0) return;
    const seat = room.seats[si];
    seat.connected = false;
    clearTimeout(seat.discTimer);
    if (hold) seat.discTimer = setTimeout(() => this.releaseSeat(room, si, seat.pid), this.cfg.holdMs);
    this.broadcastRoomOrMeta(room);
    // A running turn timer keeps ticking so a quick reconnect resumes the same turn.
    if (room.phase === 'playing' && room.game.turn === si && !room.timers.turn) this.scheduleNext(room, []);
    this.checkEmpty(room);
  }

  leave(conn) {
    const room = conn.room;
    if (!room) return;
    const pid = conn.pid;
    const spectator = conn.spectator;
    this.detach(conn, false);
    if (!spectator) {
      const si = this.seatOf(room, pid);
      if (si >= 0) this.releaseSeat(room, si, pid);
    }
    if (conn.session) conn.session.roomCode = null;
    conn.send({ t: 'left', reason: 'left' });
  }

  releaseSeat(room, si, pid) {
    const seat = room.seats[si];
    if (!seat || seat.pid !== pid) return;
    clearTimeout(seat.discTimer);
    const sess = [...this.sessions.values()].find((s) => s.pid === pid);
    if (sess && sess.roomCode === room.code) sess.roomCode = null;
    if (room.phase === 'playing') {
      Object.assign(seat, { kind: 'bot', pid: null, uid: null, pic: null, connected: true, afk: false, autoBot: true, discTimer: null, name: `${seat.name} (bot)` });
    } else {
      room.seats[si] = emptySeat();
    }
    if (room.host === pid) {
      const next = room.seats.find((s) => s.kind === 'human');
      room.host = next ? next.pid : null;
    }
    this.broadcastRoomOrMeta(room);
    if (room.phase === 'playing' && room.game.turn === si) this.scheduleNext(room, []);
    this.checkEmpty(room);
  }

  connectedHumans(room) {
    return room.seats.filter((s) => s.kind === 'human' && s.connected).length;
  }

  checkEmpty(room) {
    if (this.connectedHumans(room) > 0) return;
    if (!room.timers.empty) room.timers.empty = setTimeout(() => this.destroy(room), this.cfg.emptyRoomMs);
  }

  cancelEmpty(room) {
    clearTimeout(room.timers.empty);
    room.timers.empty = null;
  }

  destroy(room) {
    for (const k of Object.keys(room.timers)) clearTimeout(room.timers[k]);
    room.seats.forEach((s) => clearTimeout(s.discTimer));
    for (const c of [...room.conns, ...room.spectators]) {
      c.room = null;
      c.send({ t: 'left', reason: 'closed' });
      this.social?.changed(c);
    }
    for (const s of this.sessions.values()) if (s.roomCode === room.code) s.roomCode = null;
    this.rooms.delete(room.code);
  }

  shutdown() {
    for (const room of [...this.rooms.values()]) this.destroy(room);
  }

  seatOf(room, pid) {
    return pid ? room.seats.findIndex((s) => s.kind === 'human' && s.pid === pid) : -1;
  }

  // ---------- messages ----------
  snapshot(room, conn) {
    return {
      code: room.code, host: room.host, opts: room.opts, phase: room.phase,
      fillBots: room.fillBots, difficulty: room.difficulty, spectators: room.spectators.size,
      teams: room.teams,
      seats: room.seats.map((s) => ({
        kind: s.kind, name: s.name, avatar: s.avatar, color: s.color, ready: s.ready,
        connected: s.connected, afk: s.afk, host: s.kind === 'human' && s.pid === room.host,
        uid: s.kind === 'human' ? s.uid || null : null, pic: s.kind === 'human' ? s.pic || null : null,
      })),
      you: { pid: conn.pid, seat: this.seatOf(room, conn.pid), spectator: conn.spectator, host: room.host === conn.pid },
    };
  }

  playersMeta(room) {
    return room.seats.map((s) => ({
      name: s.name, avatar: s.avatar, bot: s.kind === 'bot', connected: s.connected, afk: s.afk, empty: s.kind === 'empty',
      uid: s.uid || null, pic: s.pic || null,
    }));
  }

  sendFull(room, conn) {
    if (room.phase === 'lobby') {
      conn.send({ t: 'room', seq: room.seq, room: this.snapshot(room, conn) });
    } else {
      conn.send({ t: 'game', seq: room.seq, code: room.code, state: room.game, players: this.playersMeta(room), you: this.snapshot(room, conn).you, opts: room.opts, phase: room.phase });
      if (room.timerInfo) this.sendTimer(room, conn);
    }
  }

  members(room) {
    return [...room.conns, ...room.spectators];
  }

  broadcastRoomOrMeta(room, except) {
    room.seq++;
    if (room.phase === 'lobby') {
      for (const c of this.members(room)) if (c !== except) c.send({ t: 'room', seq: room.seq, room: this.snapshot(room, c) });
    } else {
      const players = this.playersMeta(room);
      for (const c of this.members(room)) if (c !== except) c.send({ t: 'meta', seq: room.seq, players });
    }
  }

  broadcast(room, msg) {
    for (const c of this.members(room)) c.send(msg);
  }

  // ---------- lobby actions ----------
  hostSet(room, conn, fn) {
    if (room.host !== conn.pid || room.phase !== 'lobby') return conn.send({ t: 'error', code: 'notHost' });
    fn();
    this.broadcastRoomOrMeta(room);
  }

  setColor(room, conn, color) {
    if (room.phase !== 'lobby') return;
    const si = this.seatOf(room, conn.pid);
    if (si < 0 || !COLORS[color]) return;
    if (room.seats.some((s, i) => i !== si && s.kind !== 'empty' && s.color === color)) return conn.send({ t: 'error', code: 'colorTaken', msg: 'That color is taken' });
    room.seats[si].color = color;
    this.broadcastRoomOrMeta(room);
  }

  setReady(room, conn, on) {
    const si = this.seatOf(room, conn.pid);
    if (si < 0 || room.phase !== 'lobby') return;
    room.seats[si].ready = on;
    this.broadcastRoomOrMeta(room);
  }

  kick(room, conn, si) {
    if (room.host !== conn.pid) return conn.send({ t: 'error', code: 'notHost' });
    const seat = room.seats[si];
    if (!seat || seat.pid === conn.pid) return;
    if (seat.kind === 'bot' && room.phase === 'lobby') {
      room.seats[si] = emptySeat();
      return this.broadcastRoomOrMeta(room);
    }
    if (seat.kind !== 'human') return;
    const pid = seat.pid;
    room.banned.add(pid);
    const target = [...room.conns].find((c) => c.pid === pid);
    if (target) {
      room.conns.delete(target);
      target.room = null;
      target.send({ t: 'left', reason: 'kicked' });
      this.social?.changed(target);
    }
    this.releaseSeat(room, si, pid);
  }

  moveSeat(room, conn, from, to) {
    if (room.host !== conn.pid || room.phase !== 'lobby') return conn.send({ t: 'error', code: 'notHost' });
    if (!room.seats[from] || !room.seats[to] || from === to) return;
    [room.seats[from], room.seats[to]] = [room.seats[to], room.seats[from]];
    this.broadcastRoomOrMeta(room);
  }

  setTeam(room, conn, si, team) {
    if (room.host !== conn.pid || room.phase !== 'lobby') return conn.send({ t: 'error', code: 'notHost' });
    if (!room.opts.teamMode || !room.seats[si] || (team !== 0 && team !== 1)) return;
    room.teams[si] = team;
    this.broadcastRoomOrMeta(room);
  }

  shuffleSeats(room, conn) {
    if (room.host !== conn.pid || room.phase !== 'lobby') return conn.send({ t: 'error', code: 'notHost' });
    const s = room.seats;
    for (let i = s.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [s[i], s[j]] = [s[j], s[i]];
    }
    this.broadcastRoomOrMeta(room);
  }

  makeHost(room, conn, si) {
    if (room.host !== conn.pid) return conn.send({ t: 'error', code: 'notHost' });
    const seat = room.seats[si];
    if (!seat || seat.kind !== 'human' || !seat.connected || seat.pid === conn.pid) return;
    room.host = seat.pid;
    this.broadcastRoomOrMeta(room);
  }

  setBot(room, conn, si, on) {
    if (room.host !== conn.pid || room.phase !== 'lobby') return conn.send({ t: 'error', code: 'notHost' });
    const seat = room.seats[si];
    if (!seat) return;
    if (on && seat.kind === 'empty') room.seats[si] = this.botSeat(room, si);
    else if (!on && seat.kind === 'bot') room.seats[si] = emptySeat();
    this.broadcastRoomOrMeta(room);
  }

  botSeat(room, si, auto = false) {
    const taken = new Set(room.seats.filter((s, i) => i !== si && s.kind !== 'empty').map((s) => s.color));
    const pref = DEFAULT_SEAT_COLORS[room.opts.n][si];
    const color = taken.has(pref) ? COLORS.find((c) => !taken.has(c.id)).id : pref;
    const used = new Set(room.seats.map((s) => s.name));
    const name = BOT_NAMES.find((b) => !used.has(b)) || `Bot ${si + 1}`;
    return { kind: 'bot', pid: null, uid: null, pic: null, name, avatar: BOT_AVATAR, color, ready: true, connected: true, afk: false, timeouts: 0, discTimer: null, autoBot: auto };
  }

  start(room, conn) {
    if (room.host !== conn.pid) return conn.send({ t: 'error', code: 'notHost' });
    if (room.phase !== 'lobby') return;
    const humans = room.seats.filter((s) => s.kind === 'human');
    if (humans.length < this.cfg.minHumans) return conn.send({ t: 'error', code: 'needPlayers', msg: `Need at least ${this.cfg.minHumans} players` });
    if (humans.some((s) => !s.ready && s.pid !== room.host)) return conn.send({ t: 'error', code: 'notReady', msg: 'Waiting for everyone to be ready' });
    if (room.fillBots) room.seats.forEach((s, i) => { if (s.kind === 'empty') room.seats[i] = this.botSeat(room, i, true); });
    const active = room.seats.map((s) => s.kind !== 'empty');
    if (active.filter(Boolean).length < 2) return conn.send({ t: 'error', code: 'needPlayers', msg: 'Need at least 2 seats filled' });
    if (room.opts.teamMode && [0, 1].some((t) => !room.seats.some((s, i) => active[i] && room.teams[i] === t))) {
      return conn.send({ t: 'error', code: 'teams', msg: 'Both teams need at least one player' });
    }
    const firstActive = active.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
    const colors = seatColors(room.opts.n, room.seats.map((s, i) => (active[i] ? s.color : -1)));
    room.game = createGame({
      n: room.opts.n,
      seats: room.seats.map((s, i) => ({ active: active[i], color: colors[i], team: room.teams[i] })),
      opts: {
        teamMode: room.opts.teamMode, assist: room.opts.assist, quickMode: room.opts.quickMode,
        blockades: room.opts.blockades, captureToEnterHome: room.opts.captureToEnterHome,
      },
      firstTurn: firstActive[randomInt(firstActive.length)],
    });
    room.phase = 'playing';
    room.seats.forEach((s) => { s.timeouts = 0; s.afk = false; });
    room.seq++;
    for (const c of this.members(room)) this.sendFull(room, c);
    this.presence(room);
    this.scheduleNext(room, [], 900);
  }

  backToLobby(room) {
    if (room.phase !== 'over') return;
    room.phase = 'lobby';
    room.game = null;
    room.timerInfo = null;
    room.seats.forEach((s, i) => {
      if (s.kind === 'bot' && s.autoBot) room.seats[i] = emptySeat();
      else s.ready = s.kind === 'bot';
      if (s.kind === 'human' && !s.connected) room.seats[i] = emptySeat();
    });
    this.broadcastRoomOrMeta(room);
    this.presence(room);
  }

  chat(room, conn, msg) {
    const si = this.seatOf(room, conn.pid);
    if (si < 0) return;
    const now = Date.now();
    if (now - conn.lastChat < this.cfg.chatGapMs) return;
    const p = Number.isInteger(msg.p) && QUICK_CHAT[msg.p] ? msg.p : null;
    const e = Number.isInteger(msg.e) && EMOJIS[msg.e] ? msg.e : null;
    if (p == null && e == null) return;
    conn.lastChat = now;
    this.markActive(room, conn);
    this.broadcast(room, { t: 'chat', seat: si, p, e });
  }

  markActive(room, conn) {
    const si = this.seatOf(room, conn.pid);
    if (si < 0) return;
    const seat = room.seats[si];
    seat.timeouts = 0;
    if (seat.afk) {
      seat.afk = false;
      this.broadcastRoomOrMeta(room);
      if (room.phase === 'playing' && room.game.turn === si) this.scheduleNext(room, []);
    }
  }

  // ---------- turn loop ----------
  botControlled(room, si) {
    const s = room.seats[si];
    return s.kind === 'bot' || !s.connected || s.afk;
  }

  clearTurnTimers(room) {
    clearTimeout(room.timers.act);
    clearTimeout(room.timers.turn);
    room.timers.act = null;
    room.timers.turn = null;
    if (room.timerInfo) {
      room.timerInfo = null;
      this.broadcast(room, { t: 'timer', seat: -1 });
    }
  }

  scheduleNext(room, events, extra = 0) {
    this.clearTurnTimers(room);
    const st = room.game;
    if (!st || st.over || room.phase !== 'playing') return;
    if (this.connectedHumans(room) === 0 && room.spectators.size === 0) return; // paused until someone returns
    const seat = st.turn;
    const wait = animMs(events, this.cfg.animScale) + extra * this.cfg.animScale;
    const later = (ms, fn) => { room.timers.act = setTimeout(() => { room.timers.act = null; fn(); }, ms); };
    if (room.autoPlaySeat !== seat) room.autoPlaySeat = -1;
    if (this.botControlled(room, seat) || (room.autoPlaySeat === seat && st.phase === 'move')) {
      return later(wait + botThinkMs(this.cfg.animScale), () => this.botAct(room, room.autoPlaySeat === seat ? 'hard' : room.difficulty));
    }
    if (st.phase === 'move' && room.opts.autoMove && distinctMoves(st.legal).length === 1) {
      const m = distinctMoves(st.legal)[0];
      return later(wait + this.cfg.autoMoveDelay * this.cfg.animScale, () => this.act(room, { t: 'move', seat: m.seat, token: m.token }));
    }
    if (room.opts.timer) {
      later(wait, () => {
        const total = Math.round(room.opts.timer * 1000 * this.cfg.timerScale);
        room.timerInfo = { seat, endsAt: Date.now() + total, total };
        for (const c of this.members(room)) this.sendTimer(room, c);
        room.timers.turn = setTimeout(() => this.onTimeout(room, seat), total);
      });
    }
  }

  sendTimer(room, conn) {
    const t = room.timerInfo;
    if (!t) return;
    conn.send({ t: 'timer', seat: t.seat, remaining: Math.max(0, t.endsAt - Date.now()), total: t.total });
  }

  onTimeout(room, seat) {
    room.timers.turn = null;
    room.timerInfo = null;
    if (!room.game || room.game.turn !== seat || room.phase !== 'playing') return;
    const s = room.seats[seat];
    s.timeouts++;
    if (s.timeouts >= 3 && !s.afk) {
      s.afk = true;
      this.broadcastRoomOrMeta(room);
    }
    room.autoPlaySeat = seat;
    this.botAct(room, 'hard');
  }

  botAct(room, difficulty) {
    const st = room.game;
    if (!st || st.over) return;
    if (st.phase === 'roll') return this.act(room, { t: 'roll' });
    const m = chooseMove(st, difficulty);
    if (m) this.act(room, { t: 'move', seat: m.seat, token: m.token });
  }

  humanAct(room, conn, action) {
    if (room.phase !== 'playing') return;
    const si = this.seatOf(room, conn.pid);
    const st = room.game;
    if (si < 0 || st.turn !== si) return conn.send({ t: 'error', code: 'notYourTurn' });
    if (action.t === 'roll' && st.phase !== 'roll') return conn.send({ t: 'error', code: 'badAction' });
    if (action.t === 'move' && (st.phase !== 'move' || !st.legal.some((m) => m.seat === action.seat && m.token === action.token))) {
      return conn.send({ t: 'error', code: 'illegalMove' });
    }
    const seat = room.seats[si];
    seat.timeouts = 0;
    if (seat.afk) {
      seat.afk = false;
      this.broadcastRoomOrMeta(room);
    }
    room.autoPlaySeat = -1;
    this.act(room, action);
  }

  act(room, action) {
    this.clearTurnTimers(room);
    const st = room.game;
    let res;
    try {
      res = action.t === 'roll' ? roll(st, rollDie(st)) : move(st, { seat: action.seat, token: action.token });
    } catch (err) {
      console.error('engine rejected action', action, err.message);
      return;
    }
    room.game = res.state;
    room.seq++;
    this.broadcast(room, { t: 'ev', seq: room.seq, events: res.events });
    if (res.state.over) {
      room.phase = 'over';
      room.autoPlaySeat = -1;
      this.stats.gamesFinished++;
      return;
    }
    if (res.events.some((e) => e.t === 'turnChanged')) room.autoPlaySeat = -1;
    this.scheduleNext(room, res.events);
  }
}

function emptySeat() {
  return { kind: 'empty', pid: null, uid: null, pic: null, name: '', avatar: '', color: -1, ready: false, connected: false, afk: false, timeouts: 0, discTimer: null, autoBot: false };
}
