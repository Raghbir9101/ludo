// Offline game driver: runs the shared rules engine in the browser with bots in the other seats.
import { createGame, roll, move, distinctMoves } from '/shared/engine.js';
import { EMOJIS, QUICK_CHAT } from '/shared/rules.js';
import { chooseMove, botDelay } from './bot.js';
import { Emitter } from './emitter.js';
import { prefs } from './prefs.js';

function rollDie() {
  const buf = new Uint8Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 252);
  return (buf[0] % 6) + 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LocalGame extends Emitter {
  // seats: [{ active, name, avatar, color, bot, difficulty }]
  constructor({ n, seats, opts, firstTurn }) {
    super();
    this.kind = 'local';
    this.config = { n, seats, opts };
    this.players = seats.map((s) => ({ name: s.name, avatar: s.avatar, pic: s.pic || null, bot: !!s.bot, connected: true }));
    this.difficulty = seats.map((s) => s.difficulty || 'medium');
    this.mySeats = new Set(seats.map((s, i) => (s.active !== false && !s.bot ? i : -1)).filter((i) => i >= 0));
    const humans = [...this.mySeats];
    this.state = createGame({
      n,
      seats: seats.map((s) => ({ active: s.active !== false, color: s.color })),
      opts,
      firstTurn: firstTurn ?? humans[0] ?? 0,
    });
    this.view = null;
    this.gen = 0;
    this.paused = false;
  }

  start() {
    this.emit('sync', this.state);
    this.pump();
  }

  apply(res) {
    this.state = res.state;
    this.emit('events', res.events, res.state);
    this.maybeReact(res.events);
    this.pump();
  }

  roll() {
    const st = this.state;
    if (st.over || st.phase !== 'roll' || !this.mySeats.has(st.turn) || this.busy) return;
    this.apply(roll(st, rollDie()));
  }

  move(m) {
    const st = this.state;
    if (st.over || st.phase !== 'move' || !this.mySeats.has(st.turn)) return;
    if (!st.legal.some((x) => x.seat === m.seat && x.token === m.token)) return;
    this.apply(move(st, m));
  }

  chat(msg) {
    const seat = this.mySeats.has(this.state.turn) ? this.state.turn : [...this.mySeats][0];
    this.emit('chat', { seat, text: msg.p != null ? QUICK_CHAT[msg.p] : null, emoji: msg.e != null ? EMOJIS[msg.e] : null });
  }

  pause(on) {
    this.paused = on;
    if (!on) this.pump();
  }

  leave() {
    this.gen++;
    this.left = true;
  }

  // Decide what happens next once the view has finished animating.
  async pump() {
    const gen = ++this.gen;
    await this.view?.whenIdle();
    if (gen !== this.gen || this.left || this.paused) return;
    const st = this.state;
    if (st.over) return;
    const seat = st.turn;
    if (!this.mySeats.has(seat)) {
      this.busy = true;
      await sleep(window.__ludo?.fast ? 0 : botDelay());
      this.busy = false;
      if (gen !== this.gen || this.left || this.paused) return;
      if (st.phase === 'roll') this.apply(roll(st, rollDie()));
      else this.apply(move(st, chooseMove(st, this.difficulty[seat])));
      return;
    }
    if (st.phase === 'move' && prefs.autoMove && distinctMoves(st.legal).length === 1) {
      await sleep(380);
      if (gen !== this.gen || this.left || this.paused || this.state !== st) return;
      this.apply(move(st, distinctMoves(st.legal)[0]));
    }
  }

  // Bots occasionally react to captures with an emoji.
  maybeReact(events) {
    for (const e of events) {
      if (e.t !== 'captured') continue;
      const pick = (seat, list) => {
        if (!this.players[seat]?.bot || Math.random() > 0.35) return;
        setTimeout(() => this.emit('chat', { seat, emoji: list[Math.floor(Math.random() * list.length)] }), 900);
      };
      pick(e.seat, ['😡', '😢', '😮']);
      pick(e.by, ['😂', '🔥', '😀']);
    }
  }

  rematch() {
    const g = new LocalGame({ ...this.config, firstTurn: undefined });
    return g;
  }
}
