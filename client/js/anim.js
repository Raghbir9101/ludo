// Small tween engine, easing curves, frame loop and particle system.

export const Ease = {
  linear: (t) => t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inQuad: (t) => t * t,
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  outBack: (t, s = 1.9) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  inBack: (t, s = 1.7) => (s + 1) * t * t * t - s * t * t,
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export const motion = {
  reduced: false,
  turbo: false, // debug / testing: skip all animation
  ff: false,
  get fastForward() { return this.ff || this.turbo; },
  set fastForward(v) { this.ff = v; },
};

export const lerp = (a, b, t) => a + (b - a) * t;

let tweens = [];
const renderers = new Set();
let running = false;
let last = 0;

export function addRenderer(fn) {
  renderers.add(fn);
  kick();
  return () => renderers.delete(fn);
}

export function kick() {
  if (running || document.hidden) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  const dt = Math.min(64, now - last);
  last = now;
  stepTweens(dt);
  let more = tweens.length > 0;
  for (const r of renderers) more = r(dt, now) === true || more;
  if (more && !document.hidden) requestAnimationFrame(frame);
  else running = false;
}

function stepTweens(dt) {
  if (!tweens.length) return;
  const done = [];
  for (const tw of tweens) {
    tw.t += dt;
    const p = Math.min(1, tw.t / tw.ms);
    tw.fn(tw.ease(p), p);
    if (p >= 1) done.push(tw);
  }
  if (done.length) {
    tweens = tweens.filter((tw) => !done.includes(tw));
    done.forEach((tw) => tw.resolve());
  }
}

// Run fn(easedT, rawT) over ms milliseconds. Resolves when finished.
export function tween(ms, fn, ease = Ease.outCubic) {
  if (motion.fastForward || ms <= 0 || document.hidden) {
    fn(ease(1), 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    tweens.push({ ms, fn, ease, t: 0, resolve });
    kick();
  });
}

export const wait = (ms) => tween(ms, () => {});

// Complete every running tween immediately (tab hidden or the queue fell behind).
export function finishAll() {
  const list = tweens;
  tweens = [];
  for (const tw of list) {
    tw.fn(tw.ease(1), 1);
    tw.resolve();
  }
}

export const dur = (ms) => (motion.reduced ? Math.round(ms * 0.45) : ms);

// Particles in world units (board squares); drawn through a transform supplied by the caller.
export class Particles {
  constructor() {
    this.list = [];
  }

  get active() {
    return this.list.length > 0;
  }

  burst(x, y, { count = 16, colors = ['#fff'], speed = 4, life = 700, size = 0.12, gravity = 6, shape = 'circle', spread = Math.PI * 2, angle = 0 } = {}) {
    if (motion.reduced || motion.fastForward) return;
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.5 + Math.random() * 0.7);
      this.list.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, age: 0,
        size: size * (0.6 + Math.random() * 0.8), color: colors[i % colors.length], shape,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12, gravity,
      });
    }
    kick();
  }

  ring(x, y, { color = '#fff', life = 450, radius = 1.2, width = 0.12 } = {}) {
    if (motion.fastForward) return;
    this.list.push({ ring: true, x, y, color, life, age: 0, radius, width });
    kick();
  }

  update(dt) {
    const s = dt / 1000;
    for (const p of this.list) {
      p.age += dt;
      if (p.ring) continue;
      p.vy += p.gravity * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vx *= 0.985;
      p.rot += p.vr * s;
    }
    this.list = this.list.filter((p) => p.age < p.life);
    return this.active;
  }

  draw(ctx, T, u) {
    for (const p of this.list) {
      const k = p.age / p.life;
      const q = T(p);
      ctx.save();
      if (p.ring) {
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, p.width * u * (1 - k * 0.6));
        ctx.beginPath();
        ctx.arc(q.x, q.y, p.radius * u * Ease.outCubic(k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.globalAlpha = Math.min(1, (1 - k) * 1.6);
      ctx.fillStyle = p.color;
      ctx.translate(q.x, q.y);
      ctx.rotate(p.rot);
      const r = p.size * u * (1 - k * 0.4);
      if (p.shape === 'star') {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const rad = i % 2 ? r * 0.45 : r;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fill();
      } else if (p.shape === 'rect') {
        ctx.fillRect(-r, -r * 0.5, r * 2, r);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

// Full-screen confetti on its own overlay canvas (screen-pixel units).
export class Confetti {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.list = [];
    this.off = null;
  }

  fire(colors, count = 160) {
    if (motion.reduced || motion.fastForward) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.dpr = dpr;
    for (let i = 0; i < count; i++) {
      const fromLeft = i % 2 === 0;
      this.list.push({
        x: fromLeft ? -10 : w + 10, y: h * (0.55 + Math.random() * 0.3),
        vx: (fromLeft ? 1 : -1) * (250 + Math.random() * 450), vy: -(500 + Math.random() * 600),
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, w: 8 + Math.random() * 8, h: 5 + Math.random() * 6,
        color: colors[i % colors.length], age: 0, life: 2600 + Math.random() * 1200, wob: Math.random() * 6,
      });
    }
    if (!this.off) this.off = addRenderer((dt) => this.step(dt));
    kick();
  }

  step(dt) {
    const s = dt / 1000;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const p of this.list) {
      p.age += dt;
      p.vy += 900 * s;
      p.vx *= 0.99;
      p.vy = Math.min(p.vy, 260);
      p.x += (p.vx + Math.sin(p.age / 180 + p.wob) * 40) * s;
      p.y += p.vy * s;
      p.rot += p.vr * s;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p.life - p.age) / 400);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.age / 120 + p.wob));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    this.list = this.list.filter((p) => p.age < p.life);
    if (!this.list.length) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.off?.();
      this.off = null;
      return false;
    }
    return true;
  }
}
