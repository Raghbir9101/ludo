// Client mirror of an online game. Rebuilds state by replaying server events through the
// shared engine, discards stale updates by seq, and requests a full resync on gaps.
import { applyEvents } from '/shared/engine.js';
import { QUICK_CHAT, EMOJIS } from '/shared/rules.js';
import { Emitter } from './emitter.js';

export class OnlineGame extends Emitter {
  constructor(net, msg) {
    super();
    this.kind = 'online';
    this.net = net;
    this.view = null;
    this.offs = [];
    this.load(msg);
    const on = (t, fn) => this.offs.push(net.on(t, fn));
    on('game', (m) => {
      if (m.code !== this.code) return;
      this.load(m);
      this.emit('sync', this.state);
    });
    on('ev', (m) => this.onEvents(m));
    on('meta', (m) => {
      if (m.seq <= this.seq) return;
      this.seq = m.seq;
      this.players = m.players;
      this.emit('meta');
    });
    on('timer', (m) => {
      this.timerInfo = m.seat >= 0 ? { ...m, at: performance.now() } : null;
      this.emit('timer', this.timerInfo);
    });
    on('chat', (m) => this.emit('chat', { seat: m.seat, text: m.p != null ? QUICK_CHAT[m.p] : null, emoji: m.e != null ? EMOJIS[m.e] : null }));
    on('status', (s) => { if (s === 'online') this.resync(); });
  }

  load(msg) {
    this.code = msg.code;
    this.seq = msg.seq;
    this.state = msg.state;
    this.players = msg.players;
    this.isSpectator = !!msg.you.spectator;
    this.mySeats = new Set(msg.you.seat >= 0 && !msg.you.spectator ? [msg.you.seat] : []);
    this.opts = msg.opts;
  }

  onEvents(m) {
    if (m.seq <= this.seq) return;
    if (m.seq !== this.seq + 1) {
      this.resync();
      return;
    }
    try {
      this.state = applyEvents(this.state, m.events);
    } catch {
      this.resync();
      return;
    }
    this.seq = m.seq;
    this.emit('events', m.events, this.state);
  }

  get timer() {
    const t = this.timerInfo;
    if (!t) return null;
    const remaining = t.remaining - (performance.now() - t.at);
    return remaining > 0 ? { ...t, remaining } : null;
  }

  roll() {
    this.net.send('roll');
  }

  move(m) {
    this.net.send('move', { seat: m.seat, token: m.token });
  }

  chat(msg) {
    this.net.send('chat', msg);
  }

  resync() {
    this.net.send('resync');
  }

  leave() {
    this.net.send('leave');
    this.dispose();
  }

  dispose() {
    this.offs.forEach((f) => f());
    this.offs = [];
  }
}
