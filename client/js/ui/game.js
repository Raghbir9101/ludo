// Game screen: board, HUD panels, dice, input, and the ordered event animation queue.
import { BoardView, layoutTokens, colorOf, drawPawn } from '../board/render.js';
import { cellPos } from '../board/geometry.js';
import { cellOf, homeProgress, QUICK_CHAT, EMOJIS, COLORS } from '/shared/rules.js';
import { computeMove, distinctMoves } from '/shared/engine.js';
import { Dice } from '../dice.js';
import { tween, wait, Ease, motion, addRenderer, kick, Particles, Confetti, finishAll, dur, lerp } from '../anim.js';
import { audio } from '../audio.js';
import { $, h, announce, modal, avatarEl } from './dom.js';
import { prefs } from '../prefs.js';

const RING_C = 100;
const keyOf = (s, t) => `${s}:${t}`;

export class GameScreen {
  constructor({ onExit, onGameOver }) {
    this.onExit = onExit;
    this.onGameOver = onGameOver;
    this.canvas = $('#board');
    this.view = new BoardView(this.canvas);
    this.particles = new Particles();
    this.confetti = new Confetti($('#fx-overlay'));
    this.fx = new Map();
    this.queue = [];
    this.processing = false;
    this.idleWaiters = [];
    this.time = 0;
    this.dirty = true;
    this.selIdx = -1;
    this.hold = null;
    this.muted = new Set();
    this.diceCanvas = h('canvas', { class: 'dice-canvas', role: 'button', tabindex: '0', 'aria-label': 'Roll the dice' });
    this.diceHolder = h('div', { class: 'pp-dice' }, this.diceCanvas);
    this.dice = new Dice(this.diceCanvas);
    this.diceCanvas.addEventListener('click', () => this.tryRoll());
    this.diceCanvas.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.tryRoll(); }
    });
    this.bindInput();
    addRenderer((dt) => this.frame(dt));
    new ResizeObserver(() => this.layout()).observe($('#game-area'));
    this.view.onViewChange = () => this.invalidate();
    $('#game-menu').addEventListener('click', () => this.openMenu());
    $('#game-sound').addEventListener('click', () => this.toggleSound());
    $('#chat-btn').addEventListener('click', () => this.toggleChat());
    const fs = $('#game-fullscreen');
    fs.hidden = !document.fullscreenEnabled;
    fs.addEventListener('click', () => {
      audio.play('tap');
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      fs.setAttribute('aria-pressed', String(!!document.fullscreenElement));
    });
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  // ---------- lifecycle ----------
  open(ctrl, { title } = {}) {
    this.close();
    this.ctrl = ctrl;
    ctrl.view = this;
    this.st = ctrl.state;
    this.n = this.st.n;
    this.queue = [];
    this.fx.clear();
    this.muted.clear();
    this.activeSeat = this.st.turn;
    this.over = false;
    $('#game-title').textContent = title || 'Ludo Party';
    const mine = ctrl.isSpectator ? [] : [...(ctrl.mySeats || [])];
    this.view.setBoard(this.n, this.st.players.map((p) => p.color), mine.length ? Math.min(...mine) : null);
    this.syncDisp();
    this.buildPanels();
    this.layout();
    this.updateSoundIcon();
    $('#spectator-badge').hidden = !ctrl.isSpectator;
    $('#chat-btn').hidden = !!ctrl.isSpectator && !ctrl.canChat;
    $('#chat-pop').hidden = true;
    this.offs = [
      ctrl.on('events', (events, state) => this.enqueue(events, state)),
      ctrl.on('sync', (state) => this.resync(state)),
      ctrl.on('meta', () => this.refreshPanels()),
      ctrl.on('timer', (t) => this.showTimer(t)),
      ctrl.on('chat', (c) => this.showChat(c)),
    ];
    this.refreshHud();
    if (ctrl.timer) this.showTimer(ctrl.timer);
    audio.startMusic();
    if (this.st.over) this.finishGame(this.st.ranks);
    setTimeout(() => this.canvas.focus({ preventScroll: true }), 50);
  }

  close() {
    this.offs?.forEach((f) => f());
    this.offs = null;
    this.clearTimer();
    if (this.ctrl) this.ctrl.view = null;
    this.ctrl = null;
    this.flushIdle();
  }

  whenIdle() {
    if (!this.processing && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  flushIdle() {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    w.forEach((r) => r());
  }

  // ---------- state helpers ----------
  syncDisp() {
    this.disp = this.st.players.map((p) => [...p.tokens]);
    this.fx.clear();
    this.invalidate();
  }

  resync(state) {
    this.queue = [];
    finishAll();
    this.st = state;
    this.activeSeat = state.turn;
    this.syncDisp();
    this.refreshHud();
    if (state.over) this.finishGame(state.ranks);
  }

  seatName(s) {
    return this.ctrl?.players[s]?.name || COLORS[this.st.players[s].color].name;
  }

  colorName(s) {
    return COLORS[this.st.players[s].color].name;
  }

  isMine(seat) {
    return !!this.ctrl?.mySeats?.has(seat);
  }

  idle() {
    return !this.processing && this.queue.length === 0;
  }

  myMovables() {
    if (!this.ctrl || !this.idle() || this.st.over || this.st.phase !== 'move' || !this.isMine(this.st.turn)) return [];
    return distinctMoves(this.st.legal);
  }

  restPos(seat, token, prog = this.disp[seat][token]) {
    return cellPos(this.view.board, seat, cellOf(this.n, seat, prog), token);
  }

  restScale(prog) {
    if (prog < 0) return 0.9;
    if (prog >= homeProgress(this.n)) return 0.5;
    return 1;
  }

  // ---------- event queue ----------
  enqueue(events, state) {
    this.queue.push({ events, state });
    this.refreshHud();
    this.process();
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    this.selIdx = -1;
    this.hold = null;
    try {
      while (this.queue.length && this.ctrl) {
        if (this.queue.length > 3) motion.fastForward = true;
        const item = this.queue.shift();
        for (const e of item.events) {
          if (!this.ctrl) break;
          await this.animEvent(e);
        }
        this.st = item.state;
        this.syncDisp();
        if (!this.queue.length) motion.fastForward = document.hidden;
      }
    } finally {
      this.processing = false;
      motion.fastForward = document.hidden;
    }
    this.refreshHud();
    this.flushIdle();
  }

  async animEvent(e) {
    switch (e.t) {
      case 'rolled': {
        this.activeSeat = e.seat;
        this.placeDice();
        this.refreshPanels();
        audio.play('rattle');
        await this.dice.roll(e.value);
        this.panels?.[e.seat]?.die.setValue(e.value);
        audio.play('land');
        announce(`${this.seatName(e.seat)} rolled ${e.value}.`);
        if (e.value === 6) {
          audio.play('six');
          audio.vibrate(30);
          this.callout('SIX!', e.seat);
        }
        break;
      }
      case 'noMoves':
        audio.play('noMove');
        this.callout('No moves', e.seat, true);
        await wait(dur(650));
        break;
      case 'forfeit':
        audio.play('noMove');
        this.callout('3 sixes! Turn lost', e.seat, true);
        announce(`${this.seatName(e.seat)} rolled three sixes. Turn lost.`);
        await wait(dur(900));
        break;
      case 'moved':
        await this.animMove(e);
        break;
      case 'captured':
        await this.animCapture(e);
        break;
      case 'reachedHome': {
        const p = this.restPos(e.seat, e.token, homeProgress(this.n));
        const c = colorOf(this.st.players[e.seat].color);
        this.particles.burst(p.x, p.y, { count: 22, colors: [c.hex, '#fff', '#FFD54A'], shape: 'star', speed: 5, size: 0.16, gravity: 2 });
        audio.play('home');
        this.callout('HOME!', e.seat, true);
        announce(`${this.seatName(e.seat)} got a token home.`);
        await wait(dur(250));
        break;
      }
      case 'turnChanged':
        this.activeSeat = e.seat;
        this.placeDice();
        this.refreshPanels();
        this.autoPan(e.seat);
        if (this.isMine(e.seat) && !this.ctrl.isSpectator) {
          audio.play('turn');
          audio.vibrate([20, 40, 20]);
          announce(this.ctrl.mySeats.size > 1 ? `${this.seatName(e.seat)}'s turn. Press Space to roll.` : 'Your turn. Press Space to roll.', true);
        } else {
          announce(`${this.seatName(e.seat)}'s turn.`);
        }
        await wait(dur(120));
        break;
      case 'playerFinished': {
        const label = e.rank ? `${ordinal(e.rank)} place!` : 'Finished!';
        this.callout(`${this.seatName(e.seat)}: ${label}`, e.seat, true);
        audio.play(this.isMine(e.seat) ? 'win' : 'finish');
        announce(`${this.seatName(e.seat)} finished${e.rank ? ' in ' + ordinal(e.rank) + ' place' : ''}.`);
        await wait(dur(700));
        break;
      }
      case 'teamFinished':
        this.callout(`Team ${'AB'[e.team]} done!`, null, true);
        await wait(dur(600));
        break;
      case 'gameOver':
        await this.finishGame(e.ranks);
        break;
    }
  }

  async animMove(e) {
    const { seat, token, path } = e;
    const k = keyOf(seat, token);
    const start = this.restPos(seat, token, e.from);
    const f = { x: start.x, y: start.y, lift: 0, sx: 1, sy: 1, scale: this.restScale(e.from), free: true };
    this.fx.set(k, f);
    this.invalidate();
    const hop = dur(motion.reduced ? 120 : 200);
    if (e.exit) {
      audio.play('exit');
      await tween(dur(230), (t) => { f.lift = 0.9 * t; f.scale = lerp(0.9, 1.25, t); this.invalidate(); }, Ease.outBack);
      const to = cellPos(this.view.board, seat, path[0], token);
      await tween(dur(340), (t, raw) => {
        f.x = lerp(start.x, to.x, t);
        f.y = lerp(start.y, to.y, t);
        f.lift = 0.9 * (1 - raw) + Math.sin(raw * Math.PI) * 0.6;
        f.scale = lerp(1.25, 1, raw);
        this.invalidate();
      }, Ease.inOutQuad);
      await this.squash(f);
    } else {
      let from = { x: f.x, y: f.y };
      let fromScale = f.scale;
      for (let i = 0; i < path.length; i++) {
        const cell = path[i];
        const to = cellPos(this.view.board, seat, cell, token);
        const toScale = cell.k === 'h' ? 0.5 : 1;
        audio.play('hop', i);
        const sx0 = f.sx, sy0 = f.sy;
        await tween(hop, (t, raw) => {
          f.x = lerp(from.x, to.x, t);
          f.y = lerp(from.y, to.y, t);
          const arc = Math.sin(raw * Math.PI);
          f.lift = arc * 0.5;
          f.scale = lerp(fromScale, toScale, raw);
          if (!motion.reduced) {
            const rec = Math.min(1, raw / 0.3);
            f.sx = lerp(sx0, 1 - 0.08 * arc, rec);
            f.sy = lerp(sy0, 1 + 0.12 * arc, rec);
          }
          this.invalidate();
        }, Ease.inOutQuad);
        if (!motion.reduced) { f.sx = 1.24; f.sy = 0.78; }
        from = to;
        fromScale = toScale;
        this.disp[seat][token] = progressAtStep(e, i, this.n);
      }
      await this.squash(f);
    }
    this.disp[seat][token] = e.to;
    this.fx.delete(k);
    this.invalidate();
  }

  async squash(f) {
    if (motion.reduced) { f.sx = f.sy = 1; return; }
    f.sx = Math.max(f.sx, 1.24);
    f.sy = Math.min(f.sy, 0.78);
    const sx0 = f.sx, sy0 = f.sy;
    await tween(dur(200), (t) => {
      f.sx = lerp(sx0, 1, t);
      f.sy = lerp(sy0, 1, t);
      f.lift = 0;
      this.invalidate();
    }, Ease.outElastic);
  }

  async animCapture(e) {
    const k = keyOf(e.seat, e.token);
    const from = this.restPos(e.seat, e.token);
    const to = this.restPos(e.seat, e.token, -1);
    const attacker = colorOf(this.st.players[e.by].color);
    this.particles.ring(from.x, from.y, { color: attacker.hex, radius: 1.4, width: 0.18 });
    this.particles.ring(from.x, from.y, { color: '#ffffff', radius: 0.9, width: 0.1, life: 300 });
    this.particles.burst(from.x, from.y, { count: 18, colors: [attacker.hex, '#fff', colorOf(this.st.players[e.seat].color).hex], speed: 6, size: 0.12 });
    audio.play('capture');
    audio.vibrate(70);
    this.callout('CAPTURE!', e.by);
    announce(`${this.seatName(e.by)} captured ${this.seatName(e.seat)}'s token.`, true);
    const f = { x: from.x, y: from.y, lift: 0, sx: 1, sy: 1, scale: 1, rot: 0, free: true, z: 5 };
    this.fx.set(k, f);
    // Knocked up, then rewinds backwards along its own track to the yard.
    await tween(dur(200), (t, raw) => {
      f.lift = Math.sin(raw * Math.PI) * 0.7;
      f.sx = 1 + 0.15 * Math.sin(raw * Math.PI * 3) * (1 - raw);
      f.sy = 2 - f.sx;
      this.invalidate();
    }, Ease.linear);
    f.sx = f.sy = 1;
    const prog = Math.max(0, this.disp[e.seat][e.token]);
    const pts = [];
    for (let p = prog; p >= 0; p--) pts.push(this.restPos(e.seat, e.token, p));
    pts.push(to);
    const segs = pts.length - 1;
    await tween(dur(Math.min(720, 160 + segs * 28)), (t) => {
      const x = t * segs;
      const i = Math.min(segs - 1, Math.floor(x));
      const r = x - i;
      f.x = lerp(pts[i].x, pts[i + 1].x, r);
      f.y = lerp(pts[i].y, pts[i + 1].y, r);
      f.lift = i === segs - 1 ? Math.sin(r * Math.PI) * 0.8 : Math.abs(Math.sin(r * Math.PI)) * 0.12;
      f.scale = i === segs - 1 ? lerp(1, 0.9, r) : 1;
      this.invalidate();
    }, Ease.inOutQuad);
    await this.squash(f);
    this.disp[e.seat][e.token] = -1;
    this.fx.delete(k);
    this.invalidate();
  }

  async finishGame(ranks) {
    if (this.over) return;
    this.over = true;
    this.clearTimer();
    const st = this.st;
    const winnerSeats = st.opts.teamMode ? st.players.filter((p) => p.active && p.team === ranks[0]).map((p) => p.seat) : [ranks[0]];
    const colors = winnerSeats.map((s) => colorOf(st.players[s].color).hex);
    this.confetti.fire([...colors, '#ffffff', '#FFD54A']);
    const iWon = winnerSeats.some((s) => this.isMine(s));
    audio.play(iWon || this.ctrl?.isSpectator ? 'win' : 'finish');
    this.callout(st.opts.teamMode ? `Team ${'AB'[ranks[0]]} wins!` : `${this.seatName(ranks[0])} wins!`, winnerSeats[0]);
    announce(st.opts.teamMode ? `Game over. Team ${'AB'[ranks[0]]} wins.` : `Game over. ${this.seatName(ranks[0])} wins.`, true);
    audio.stopMusic(true);
    await wait(motion.fastForward ? 0 : 1700);
    this.onGameOver?.(this.ctrl, ranks);
  }

  // ---------- HUD ----------
  buildPanels() {
    const top = $('#panels-top');
    const bottom = $('#panels-bottom');
    top.replaceChildren();
    bottom.replaceChildren();
    this.panels?.forEach((p) => p?.die.destroy());
    this.panels = [];
    const b = this.view.board;
    const seats = this.st.players.filter((p) => p.active).map((p) => p.seat);
    const placed = seats.map((s) => ({ s, x: b.yards[s].center.x, y: b.yards[s].center.y }));
    const tops = placed.filter((p) => p.y < -0.01).sort((a, c) => a.x - c.x);
    const bots = placed.filter((p) => p.y >= -0.01).sort((a, c) => a.x - c.x);
    const make = (p, row) => {
      const s = p.s;
      const c = colorOf(this.st.players[s].color);
      const ring = svgRing();
      const face = h('span', { class: 'pp-face' });
      const dieCanvas = h('canvas', { class: 'dice-canvas', 'aria-hidden': 'true' });
      const el = h('div', { class: `player-panel${p.x > 0.01 ? ' right' : ''}`, style: { '--pc': c.hex }, 'data-seat': s, role: 'group' },
        h('div', { class: 'pp-pin' }, face, h('span', { class: 'pp-home' }), h('span', { class: 'pp-tag' })),
        h('div', { class: 'pp-dicebox' }, ring.svg, h('div', { class: 'pp-last' }, dieCanvas)),
      );
      row.append(el);
      const die = new Dice(dieCanvas);
      die.dim = true;
      this.panels[s] = { el, ring: ring.ring, die, face, picKey: undefined, home: el.querySelector('.pp-home'), tag: el.querySelector('.pp-tag'), box: el.querySelector('.pp-dicebox') };
      requestAnimationFrame(() => die.invalidate());
    };
    tops.forEach((p) => make(p, top));
    bots.forEach((p) => make(p, bottom));
    const compact = Math.max(tops.length, bots.length) >= 3 && $('#game-area').clientWidth < 560;
    top.classList.toggle('compact', compact);
    bottom.classList.toggle('compact', compact);
    this.refreshPanels();
    this.placeDice();
  }

  refreshPanels() {
    if (!this.ctrl || !this.panels) return;
    const H = homeProgress(this.n);
    const soloHuman = (this.ctrl.mySeats?.size ?? 0) === 1 && !this.ctrl.isSpectator;
    this.labels = [];
    for (const p of this.st.players) {
      const pan = this.panels[p.seat];
      if (!pan) continue;
      const meta = this.ctrl.players[p.seat] || {};
      const name = soloHuman && this.isMine(p.seat) ? 'You' : (meta.name || this.colorName(p.seat));
      const home = this.disp[p.seat].filter((x) => x === H).length;
      let tag = '';
      if (meta.afk) tag = 'AFK';
      else if (meta.connected === false) tag = 'offline';
      this.labels[p.seat] = name + (tag ? ` (${tag})` : '');
      this.setFace(pan, meta, p.color);
      pan.el.title = meta.name || this.colorName(p.seat);
      pan.home.textContent = String(home);
      pan.home.hidden = home === 0;
      pan.tag.textContent = this.st.opts.teamMode ? 'AB'[p.team] : '';
      pan.tag.hidden = !this.st.opts.teamMode;
      pan.el.classList.toggle('active', p.seat === this.activeSeat && !this.st.over);
      pan.el.classList.toggle('done', p.done);
      const extra = [this.st.opts.teamMode ? `team ${'AB'[p.team]}` : '', meta.bot ? 'bot' : '', tag].filter(Boolean).join(', ');
      pan.el.setAttribute('aria-label', `${name}${extra ? ` (${extra})` : ''}, ${home} of 4 tokens home${p.seat === this.activeSeat ? ', playing now' : ''}`);
    }
    this.invalidate();
  }

  // Panel tab: the player's photo or avatar, with a small pin badge in their color.
  setFace(pan, meta, color) {
    const key = `${meta.pic || ''}|${meta.avatar || ''}`;
    if (pan.picKey === key) return;
    pan.picKey = key;
    const pin = h('canvas', { class: 'pin-icon mini', 'aria-hidden': 'true' });
    pan.face.replaceChildren(avatarEl(meta, 'pp-photo'), pin);
    requestAnimationFrame(() => drawPinIcon(pin, color));
  }

  placeDice() {
    const pan = this.panels?.[this.activeSeat];
    if (!pan) return;
    if (this.diceHolder.parentNode !== pan.box) pan.box.append(this.diceHolder);
    const c = colorOf(this.st.players[this.activeSeat].color);
    this.diceCanvas.style.setProperty('--pc', c.hex);
    this.dice.invalidate();
  }

  refreshHud() {
    if (!this.ctrl) return;
    this.refreshPanels();
    const st = this.st;
    const mine = this.isMine(st.turn) && !this.ctrl.isSpectator;
    const canRoll = this.idle() && mine && st.phase === 'roll' && !st.over;
    this.dice.dim = !canRoll && !this.dice.rolling && this.idle();
    this.diceCanvas.classList.toggle('can-roll', canRoll);
    this.diceHolder.classList.toggle('your-roll', canRoll);
    this.diceCanvas.style.pointerEvents = canRoll ? 'auto' : 'none';
    this.diceCanvas.tabIndex = canRoll ? 0 : -1;
    this.dice.invalidate();
    let status = '';
    if (st.over) status = 'Game over';
    else if (!this.idle()) status = '';
    else if (mine && st.phase === 'roll') status = this.ctrl.mySeats.size > 1 ? `${this.seatName(st.turn)}: tap the dice` : 'Your turn: tap the dice';
    else if (mine && st.phase === 'move') status = this.ctrl.mySeats.size > 1 ? `${this.seatName(st.turn)}: pick a token` : 'Pick a token to move';
    else status = `${this.seatName(st.turn)} is playing...`;
    $('#game-status').textContent = status;
    const mv = this.myMovables();
    if (mv.length && this.selIdx >= mv.length) this.selIdx = -1;
    this.invalidate();
  }

  showTimer(t) {
    this.clearTimer();
    if (!t || !this.panels?.[t.seat]) return;
    const ring = this.panels[t.seat].ring;
    this.timerRing = ring;
    const frac = Math.max(0, Math.min(1, t.remaining / t.total));
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = String(RING_C * (1 - frac));
    ring.style.opacity = '1';
    void ring.getBoundingClientRect();
    ring.style.transition = `stroke-dashoffset ${t.remaining}ms linear`;
    ring.style.strokeDashoffset = String(RING_C);
    const endAt = performance.now() + t.remaining;
    const mine = this.isMine(t.seat);
    this.timerTick = setInterval(() => {
      const left = endAt - performance.now();
      ring.classList.toggle('low', left < 5000);
      if (mine && left < 5000 && left > 0) audio.play('tick');
      if (left <= 0) this.clearTimer();
    }, 1000);
  }

  clearTimer() {
    clearInterval(this.timerTick);
    if (this.timerRing) {
      this.timerRing.style.transition = 'none';
      this.timerRing.style.opacity = '0';
      this.timerRing.classList.remove('low');
    }
    this.timerRing = null;
  }

  callout(text, seat, small = false) {
    if (motion.fastForward) return;
    const c = seat != null ? colorOf(this.st.players[seat].color) : null;
    const el = h('div', { class: `callout${small ? ' sm' : ''}`, style: c ? { '--cc': c.dark } : {} }, text);
    $('#callouts').append(el);
    setTimeout(() => el.remove(), 1050);
  }

  showChat({ seat, text, emoji }) {
    if (this.muted.has(seat)) return;
    const pan = this.panels?.[seat];
    if (!pan) return;
    pan.el.querySelector('.bubble')?.remove();
    const b = h('div', { class: `bubble${emoji ? ' emoji' : ''}` }, emoji || text);
    pan.el.append(b);
    audio.play('chat');
    announce(`${this.seatName(seat)} says ${emoji || text}`);
    setTimeout(() => b.remove(), 2600);
  }

  toggleChat() {
    const pop = $('#chat-pop');
    if (!pop.hidden) { pop.hidden = true; $('#chat-btn').setAttribute('aria-expanded', 'false'); return; }
    audio.play('tap');
    const send = (msg) => { this.ctrl?.chat(msg); pop.hidden = true; $('#chat-btn').setAttribute('aria-expanded', 'false'); };
    const others = this.st.players.filter((p) => p.active && !this.isMine(p.seat) && !this.ctrl.players[p.seat]?.bot);
    pop.replaceChildren(
      h('div', { class: 'phrases' }, QUICK_CHAT.map((p, i) => h('button', { onclick: () => send({ p: i }) }, p))),
      h('div', { class: 'emojis' }, EMOJIS.map((e, i) => h('button', { 'aria-label': `Send ${e}`, onclick: () => send({ e: i }) }, e))),
      others.length ? h('div', { class: 'mutes' }, 'Mute:', others.map((p) => {
        const b = h('button', { 'aria-pressed': String(this.muted.has(p.seat)) }, this.seatName(p.seat));
        b.addEventListener('click', () => {
          if (this.muted.has(p.seat)) this.muted.delete(p.seat); else this.muted.add(p.seat);
          b.setAttribute('aria-pressed', String(this.muted.has(p.seat)));
        });
        return b;
      })) : null,
    );
    if (this.ctrl.isSpectator) pop.querySelector('.phrases').remove();
    pop.hidden = false;
    $('#chat-btn').setAttribute('aria-expanded', 'true');
    pop.querySelector('button')?.focus();
  }

  openMenu() {
    audio.play('tap');
    this.ctrl?.pause?.(true);
    modal({
      title: 'Menu',
      body: this.ctrl?.kind === 'online' ? `Room ${this.ctrl.code}` : 'Game paused',
      actions: [
        { label: 'RESUME', cls: 'c-green', onClick: () => this.ctrl?.pause?.(false) },
        { label: 'LEAVE GAME', cls: 'c-red', onClick: () => { this.ctrl?.leave(); this.onExit?.(); } },
      ],
      cancel: () => this.ctrl?.pause?.(false),
    });
  }

  toggleSound() {
    const on = !(prefs.sfx || prefs.music);
    prefs.sfx = on;
    prefs.music = on;
    audio.setSfx(on);
    audio.setMusic(on);
    if (on) audio.startMusic();
    this.updateSoundIcon();
  }

  updateSoundIcon() {
    $('#game-sound').textContent = prefs.sfx || prefs.music ? '🔊' : '🔇';
  }

  autoPan(seat) {
    if (!this.view.gestures || this.view.fit > 24) return;
    const y = this.view.board.yards[seat].center;
    const arm = this.view.board.arms[seat];
    const p = { x: (y.x + arm.e.x * (this.view.board.apothem + 3)) / 2, y: (y.y + arm.e.y * (this.view.board.apothem + 3)) / 2 };
    this.view.focusOn(p, Math.max(this.view.zoom, 1.45));
    kick();
  }

  // ---------- input ----------
  tryRoll() {
    audio.unlock();
    this.ctrl?.here?.();
    const st = this.st;
    if (!this.ctrl || !this.idle() || st.over || st.phase !== 'roll' || !this.isMine(st.turn) || this.ctrl.isSpectator) return;
    this.diceCanvas.classList.remove('can-roll');
    this.diceCanvas.style.pointerEvents = 'none';
    this.ctrl.roll();
  }

  doMove(m) {
    audio.unlock();
    this.selIdx = -1;
    this.hold = null;
    this.ctrl?.move({ seat: m.seat, token: m.token });
  }

  pickAt(p) {
    const mv = this.myMovables();
    if (!mv.length) return null;
    const w = this.view.toWorld(p.x, p.y);
    let best = null, bestD = Infinity;
    for (const m of mv) {
      const pos = this.restPos(m.seat, m.token);
      // Pins stand above their square, so test their head too.
      const d = Math.min(Math.hypot(pos.x - w.x, pos.y - w.y), Math.hypot(pos.x - w.x, pos.y - 0.55 - w.y));
      if (d < bestD) { bestD = d; best = m; }
    }
    return bestD < 0.95 ? best : null;
  }

  bindInput() {
    this.view.onTap = (p) => {
      audio.unlock();
      if (this.suppressTap) { this.suppressTap = false; return; }
      const m = this.pickAt(p);
      if (m) this.doMove(m);
      else if (this.idle() && this.st.phase === 'roll' && this.isMine(this.st.turn)) this.pulseDice();
    };
    this.view.onPress = (p) => {
      this.ctrl?.here?.();
      clearTimeout(this.holdTimer);
      const m = this.pickAt(p);
      if (!m) return;
      this.holdTimer = setTimeout(() => {
        this.hold = m;
        this.invalidate();
        audio.play('tap');
      }, 300);
    };
    this.view.onRelease = () => {
      clearTimeout(this.holdTimer);
      if (this.hold) {
        this.hold = null;
        this.suppressTap = true;
        this.invalidate();
      }
    };
    this.canvas.addEventListener('keydown', (e) => {
      const mv = this.myMovables();
      if ((e.key === ' ' || e.key === 'Enter') && this.st.phase === 'roll') {
        e.preventDefault();
        this.tryRoll();
        return;
      }
      if (!mv.length) return;
      if (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const back = e.shiftKey || e.key === 'ArrowLeft' || e.key === 'ArrowUp';
        // Tab past the last (or before the first) token lets focus leave the board.
        if (e.key === 'Tab' && this.selIdx === (back ? 0 : mv.length - 1)) {
          this.selIdx = -1;
          this.invalidate();
          return;
        }
        e.preventDefault();
        this.selIdx = this.selIdx < 0 ? (back ? mv.length - 1 : 0) : (this.selIdx + (back ? -1 : 1) + mv.length) % mv.length;
        const m = mv[this.selIdx];
        announce(`${this.colorName(m.seat)} token ${m.token + 1}${m.from < 0 ? ' in the yard' : ''}. ${mv.length} options. Press Enter to move.`);
        this.invalidate();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.doMove(mv[Math.max(0, this.selIdx)]);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!this.ctrl || !$('#scr-game').classList.contains('active')) return;
      if (e.key === ' ' && document.activeElement === document.body) {
        e.preventDefault();
        this.tryRoll();
      }
      if (e.key === 'Escape') {
        if (!$('#chat-pop').hidden) {
          $('#chat-pop').hidden = true;
          $('#chat-btn').setAttribute('aria-expanded', 'false');
          $('#chat-btn').focus();
        } else if (!this.over) $('#game-menu').click();
      }
    });
  }

  pulseDice() {
    this.diceHolder.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
  }

  onVisibility() {
    if (document.hidden) {
      motion.fastForward = true;
      finishAll();
      audio.suspend();
    } else {
      motion.fastForward = this.queue.length > 0;
      audio.resume();
      this.ctrl?.resync?.();
      this.invalidate();
    }
  }

  layout() {
    const area = $('#game-area');
    const wrap = $('#board-wrap');
    if (this.view.board && area.clientHeight) {
      const b = this.view.board.bounds;
      const aspect = (b.maxY - b.minY + 1.2) / (b.maxX - b.minX + 0.8);
      const avail = area.clientHeight - $('#panels-top').offsetHeight - $('#panels-bottom').offsetHeight - 12;
      const hgt = Math.max(160, Math.min(avail, area.clientWidth * aspect));
      if (Math.abs(wrap.offsetHeight - hgt) > 1) wrap.style.height = `${Math.floor(hgt)}px`;
    }
    this.view.resize();
    if (this.view.board) {
      const b = this.view.board.bounds;
      const px = `${Math.round((b.maxX - b.minX + 0.8) * this.view.fit) + 16}px`;
      for (const el of [$('#panels-top'), $('#panels-bottom')]) el.style.maxWidth = px;
    }
    this.invalidate();
  }

  // ---------- rendering ----------
  invalidate() {
    this.dirty = true;
    kick();
  }

  frame(dt) {
    if (!this.ctrl || !$('#scr-game').classList.contains('active')) return false;
    this.time += dt / 1000;
    const viewAnim = this.view.update(dt);
    const partAnim = this.particles.update(dt);
    const movables = this.myMovables();
    const animating = viewAnim || partAnim || movables.length > 0 || this.fx.size > 0;
    if (!this.dirty && !animating) return false;
    this.dirty = false;
    this.render(movables);
    return animating;
  }

  render(movables) {
    const n = this.n;
    const H = homeProgress(n);
    const movKeys = new Map(movables.map((m) => [keyOf(m.seat, m.token), m]));
    // Every token sharing a square with a movable token moves the same way.
    const items = [];
    for (const p of this.st.players) {
      if (!p.active) continue;
      for (let t = 0; t < 4; t++) {
        const k = keyOf(p.seat, t);
        const f = this.fx.get(k);
        if (f) {
          items.push({ ...f, color: p.color });
          continue;
        }
        const prog = this.disp[p.seat][t];
        const cell = cellOf(n, p.seat, prog);
        const pos = cellPos(this.view.board, p.seat, cell, t);
        const cellKey = cell.k === 't' ? `t${cell.i}` : cell.k === 'c' ? `c${p.seat}:${cell.i}` : `${cell.k}${p.seat}:${t}`;
        const it = { x: pos.x, y: pos.y, color: p.color, cellKey, scale: prog >= H ? 0.5 : prog < 0 ? 0.9 : 1, seat: p.seat, token: t };
        if (movKeys.has(k)) {
          it.lift = 0.28 * Math.abs(Math.sin(this.time * 4.6));
          it.movable = true;
          it.z = 1;
        }
        items.push(it);
      }
    }
    const scene = layoutTokens(this.view.board, items);
    scene.labels = this.labels;
    const sel = this.selIdx >= 0 ? movables[this.selIdx] : null;
    const ghostMove = this.hold || sel;
    scene.under = (ctx, v) => {
      const u = v.u;
      // Spinning dashed selector ring around the base of every token that can move.
      for (const m of movables) {
        const pos = v.T(this.restPos(m.seat, m.token));
        const isSel = sel && sel.seat === m.seat && sel.token === m.token;
        const c = colorOf(this.st.players[m.seat].color);
        const scale = this.restScale(this.disp[m.seat][m.token]);
        const rx = u * 0.46 * scale, ry = u * 0.27 * scale;
        const cy = pos.y + u * 0.1 * scale;
        const dash = Math.max(2, u * 0.13);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(pos.x, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(3, u * (isSel ? 0.17 : 0.13));
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.setLineDash([dash, dash * 0.7]);
        ctx.lineDashOffset = -this.time * u * 1.4;
        ctx.lineWidth = Math.max(2, u * (isSel ? 0.12 : 0.08));
        ctx.strokeStyle = isSel ? '#2a2540' : c.dark;
        ctx.stroke();
        ctx.restore();
      }
      if (ghostMove) {
        const res = computeMove(this.st, ghostMove.seat, ghostMove.token, this.st.dice);
        if (res) {
          ctx.fillStyle = 'rgba(42,37,64,0.35)';
          for (const c of res.path.slice(0, -1)) {
            const q = v.T(cellPos(v.board, ghostMove.seat, c, ghostMove.token));
            ctx.beginPath();
            ctx.arc(q.x, q.y, u * 0.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };
    scene.over = (ctx, v) => {
      if (ghostMove) {
        const res = computeMove(this.st, ghostMove.seat, ghostMove.token, this.st.dice);
        if (res) {
          const last = res.path[res.path.length - 1];
          const q = v.T(cellPos(v.board, ghostMove.seat, last, ghostMove.token));
          ctx.save();
          ctx.setLineDash([u4(v), u4(v)]);
          ctx.beginPath();
          ctx.arc(q.x, q.y, v.u * 0.45, 0, Math.PI * 2);
          ctx.lineWidth = Math.max(2, v.u * 0.08);
          ctx.strokeStyle = '#2a2540';
          ctx.stroke();
          ctx.restore();
          drawGhost(ctx, q, v, this.st.players[ghostMove.seat].color, last.k === 'h' ? 0.5 : 1);
        }
      }
      this.particles.draw(ctx, v.T, v.u);
    };
    this.view.draw(scene);
  }
}

function u4(v) {
  return Math.max(3, v.u * 0.12);
}

function drawGhost(ctx, q, v, color, scale) {
  drawPawn(ctx, q.x, q.y, v.u, color, { alpha: 0.5, scale });
}

function drawPinIcon(canvas, color) {
  const css = canvas.clientWidth || 34;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, css, css);
  drawPawn(ctx, css / 2, css * 0.8, css * 0.82, color);
}

// Timer track running around the dice box.
function svgRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 60 60');
  svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(ns, 'rect');
  const ring = document.createElementNS(ns, 'rect');
  for (const c of [bg, ring]) {
    c.setAttribute('x', '3');
    c.setAttribute('y', '3');
    c.setAttribute('width', '54');
    c.setAttribute('height', '54');
    c.setAttribute('rx', '11');
    c.setAttribute('pathLength', '100');
  }
  bg.setAttribute('class', 'ring-bg');
  ring.setAttribute('class', 'ring');
  ring.style.strokeDasharray = String(RING_C);
  ring.style.strokeDashoffset = String(RING_C);
  ring.style.opacity = '0';
  svg.append(bg, ring);
  return { svg, ring };
}

function progressAtStep(e, i, n) {
  // Progress value corresponding to path[i] for a non-exit move.
  let p = e.from;
  const L = n * 13 - 2;
  for (let s = 0; s <= i; s++) {
    const c = e.path[s];
    if (c.k === 'c') p = n * 13 + c.i;
    else if (c.k === 'h') p = n * 13 + 5;
    else p = p === L ? L + 1 : p === L + 1 ? 0 : p + 1;
  }
  return p;
}

export function ordinal(n) {
  return n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
}
