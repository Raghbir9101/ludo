// Dice rendering and roll animation on a small dedicated canvas.
import { tween, Ease, motion, addRenderer, kick } from './anim.js';

const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

export class Dice {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.value = 6;
    this.rot = 0;
    this.scale = 1;
    this.sx = 1;
    this.sy = 1;
    this.offX = 0;
    this.offY = 0;
    this.yaw = 0;
    this.nextValue = 1;
    this.dim = false;
    this.rolling = false;
    this.dirty = true;
    this.off = addRenderer(() => {
      if (this.dirty) this.draw();
      return false;
    });
    this.draw();
  }

  invalidate() {
    this.dirty = true;
    kick();
  }

  setValue(v) {
    this.value = v;
    this.invalidate();
  }

  draw() {
    this.dirty = false;
    const c = this.canvas;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const css = c.clientWidth || 54;
    if (c.width !== Math.round(css * dpr)) {
      c.width = Math.round(css * dpr);
      c.height = Math.round(css * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const s = css * 0.64 * this.scale;
    const cx = css / 2 + this.offX, cy = css / 2 + this.offY;
    // Soft shadow stays on the ground.
    const lift = Math.max(0, -this.offY);
    ctx.fillStyle = `rgba(30,15,60,${0.25 - Math.min(0.15, lift / 80)})`;
    ctx.beginPath();
    ctx.ellipse(css / 2, css / 2 + s * 0.58, s * 0.5 * (1 - lift / 90), s * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rot);
    ctx.scale(this.sx, this.sy);
    ctx.globalAlpha = this.dim ? 0.55 : 1;
    const a = ((this.yaw % HALF) + HALF) % HALF;
    if (!a) {
      face(ctx, s, s, this.value, 0);
    } else {
      // Cube turning about its vertical axis: two faces share the width.
      const w1 = s * Math.cos(a), w2 = s * Math.sin(a);
      const x0 = -(w1 + w2) / 2;
      ctx.save();
      ctx.translate(x0 + w1 / 2, 0);
      face(ctx, w1, s, this.value, Math.sin(a) * 0.35);
      ctx.restore();
      ctx.save();
      ctx.translate(x0 + w1 + w2 / 2, 0);
      face(ctx, w2, s, this.nextValue, Math.cos(a) * 0.35);
      ctx.restore();
    }
    ctx.restore();
  }

  // Shake, tumble with flickering faces, then land with a bounce on `value`.
  async roll(value) {
    this.rolling = true;
    if (motion.reduced || motion.fastForward) {
      await tween(motion.fastForward ? 0 : 160, (t) => {
        this.value = t < 1 ? 1 + Math.floor(Math.random() * 6) : value;
        this.invalidate();
      }, Ease.linear);
      this.value = value;
      this.rolling = false;
      this.invalidate();
      return;
    }
    await tween(130, (t) => {
      this.rot = Math.sin(t * Math.PI * 6) * 0.28 * (1 - t * 0.3);
      this.offX = Math.sin(t * Math.PI * 8) * 3;
      this.invalidate();
    }, Ease.linear);
    // Tumbles through quarter turns (each shows a new face), ending on `value`.
    const turns = 6;
    const randFace = (not) => { let v; do v = 1 + Math.floor(Math.random() * 6); while (v === not); return v; };
    this.nextValue = randFace(this.value);
    let quarter = 0;
    const tilt = (Math.random() < 0.5 ? -1 : 1) * 0.35;
    await tween(520, (t, raw) => {
      const y = t * turns * HALF;
      const q = Math.min(turns, Math.floor(y / HALF + 1e-6));
      while (quarter < q) {
        quarter++;
        this.value = this.nextValue;
        this.nextValue = quarter === turns - 1 ? value : randFace(this.value);
      }
      this.yaw = q >= turns ? 0 : y;
      this.rot = Math.sin(raw * Math.PI) * tilt;
      this.offX = 0;
      this.offY = -Math.sin(raw * Math.PI) * 14;
      this.scale = 1 + Math.sin(raw * Math.PI) * 0.18;
      this.invalidate();
    }, Ease.outQuad);
    this.value = value;
    this.yaw = 0;
    this.rot = 0;
    this.offY = 0;
    await tween(200, (t) => {
      const sq = 1 - t;
      this.sx = 1 + 0.22 * sq;
      this.sy = 1 - 0.18 * sq;
      this.scale = 0.9 + 0.1 * Ease.outBack(t);
      this.invalidate();
    }, Ease.linear);
    this.sx = this.sy = this.scale = 1;
    this.rolling = false;
    this.invalidate();
  }

  destroy() {
    this.off?.();
  }
}

const HALF = Math.PI / 2;

// One die face, w wide and s tall, centered on the origin. shade darkens faces turned away.
function face(ctx, w, s, value, shade) {
  if (w < 0.5) return;
  const r = Math.min(s * 0.22, w / 2);
  ctx.save();
  ctx.fillStyle = '#b9bcc6';
  rr(ctx, -w / 2, -s / 2 + s * 0.09, w, s, r);
  ctx.fill();
  const g = ctx.createLinearGradient(0, -s / 2, 0, s / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#e9ebf0');
  ctx.fillStyle = g;
  rr(ctx, -w / 2, -s / 2, w, s, r);
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.035);
  ctx.strokeStyle = '#9da1ad';
  ctx.stroke();
  ctx.scale(w / s, 1);
  ctx.fillStyle = '#16181f';
  const pr = s * (value === 1 ? 0.13 : 0.095);
  for (const [px, py] of PIPS[value] || PIPS[1]) {
    ctx.beginPath();
    ctx.arc(px * s * 0.26, py * s * 0.26, pr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (shade > 0) {
    ctx.fillStyle = `rgba(40,45,70,${shade})`;
    rr(ctx, -w / 2, -s / 2, w, s, r);
    ctx.fill();
  }
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
