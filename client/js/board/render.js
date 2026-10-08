// Canvas renderer for the board, tokens and in-board highlights.
// The static board is cached on an offscreen canvas and only redrawn when the view changes.
import { buildBoard, rotateBoard, povSteps } from './geometry.js';
import { COLORS, seatColors as distinctColors } from '/shared/rules.js';

const GRID = '#9b9ba3';
const INK = '#1b2440';
const TAU = Math.PI * 2;

export function colorOf(idx) {
  return COLORS[idx] || COLORS[0];
}

export function symbolPath(ctx, sym, x, y, r) {
  ctx.beginPath();
  switch (sym) {
    case 'circle':
      ctx.arc(x, y, r * 0.8, 0, TAU);
      break;
    case 'square':
      ctx.rect(x - r * 0.72, y - r * 0.72, r * 1.44, r * 1.44);
      break;
    case 'triangle':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.95, y + r * 0.7);
      ctx.lineTo(x - r * 0.95, y + r * 0.7);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.8, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.8, y);
      ctx.closePath();
      break;
    case 'star':
      starPath(ctx, x, y, r, r * 0.45, 5);
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + Math.PI / 6;
        ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9);
      }
      ctx.closePath();
      break;
    case 'cross': {
      const w = r * 0.34;
      ctx.moveTo(x - w, y - r); ctx.lineTo(x + w, y - r); ctx.lineTo(x + w, y - w);
      ctx.lineTo(x + r, y - w); ctx.lineTo(x + r, y + w); ctx.lineTo(x + w, y + w);
      ctx.lineTo(x + w, y + r); ctx.lineTo(x - w, y + r); ctx.lineTo(x - w, y + w);
      ctx.lineTo(x - r, y + w); ctx.lineTo(x - r, y - w); ctx.lineTo(x - w, y - w);
      ctx.closePath();
      break;
    }
    case 'crescent':
      ctx.arc(x, y, r * 0.9, Math.PI * 0.25, Math.PI * 1.75, false);
      ctx.arc(x + r * 0.45, y, r * 0.68, Math.PI * 1.55, Math.PI * 0.45, true);
      ctx.closePath();
      break;
  }
}

export function starPath(ctx, x, y, R, r, points = 5, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 ? r : R;
    const a = rot + (i * Math.PI) / points;
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
}

// Map-pin token on a colored base ring. (x, y) is the center of the square it stands on;
// u is pixels per square. The base stays on the ground while the pin hops.
export function drawPawn(ctx, x, y, u, colorIdx, o = {}) {
  const c = colorOf(colorIdx);
  const k = u * (o.scale ?? 1);
  const sx = o.sx ?? 1, sy = o.sy ?? 1;
  const lift = o.lift ?? 0;
  const alpha = o.alpha ?? 1;
  if (k <= 0.5 || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;

  const by = y + k * 0.1;
  const shrink = Math.max(0.55, 1 - lift * 0.6);
  ctx.beginPath();
  ctx.ellipse(x, by, k * 0.36 * shrink, k * 0.17 * shrink, 0, 0, TAU);
  ctx.fillStyle = c.dark;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, by - k * 0.01, k * 0.28 * shrink, k * 0.125 * shrink, 0, 0, TAU);
  ctx.fillStyle = c.hex;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, by - k * 0.015, k * 0.15 * shrink, k * 0.065 * shrink, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();

  ctx.translate(x, by - lift * u);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(sx, sy);

  const R = k * 0.3, hy = -k * 0.66;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-k * 0.06, -k * 0.14, -R, -k * 0.42, -R, hy);
  ctx.arc(0, hy, R, Math.PI, 0, false);
  ctx.bezierCurveTo(R, -k * 0.42, k * 0.06, -k * 0.14, 0, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-R, 0, R, 0);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.45, '#eef0f4');
  g.addColorStop(1, '#a9afbb');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, k * 0.035);
  ctx.strokeStyle = 'rgba(40,44,60,0.65)';
  ctx.stroke();

  const br = R * 0.68;
  const bg = ctx.createRadialGradient(-br * 0.35, hy - br * 0.4, br * 0.1, 0, hy, br);
  bg.addColorStop(0, c.light);
  bg.addColorStop(0.45, c.hex);
  bg.addColorStop(1, c.dark);
  ctx.beginPath();
  ctx.arc(0, hy, br, 0, TAU);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  symbolPath(ctx, c.symbol, 0, hy + br * 0.08, br * 0.38);
  ctx.globalAlpha = alpha * 0.55;
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(-br * 0.38, hy - br * 0.45, br * 0.28, br * 0.16, -0.6, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Classic cartoon pawn (used for logo art).
export function drawClassicPawn(ctx, x, y, u, colorIdx, o = {}) {
  const c = colorOf(colorIdx);
  const k = u * (o.scale ?? 1);
  const sx = o.sx ?? 1, sy = o.sy ?? 1;
  const lift = o.lift ?? 0;
  const alpha = o.alpha ?? 1;
  if (k <= 0.5 || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Shadow stays on the ground while the pawn hops.
  const sh = Math.max(0.35, 1 - lift * 0.9);
  ctx.fillStyle = 'rgba(20,10,40,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, y + k * 0.3, k * 0.34 * sh * sx, k * 0.11 * sh, 0, 0, TAU);
  ctx.fill();

  ctx.translate(x, y + k * 0.3 - lift * u);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(sx, sy);
  ctx.translate(0, -k * 0.3);

  ctx.lineWidth = Math.max(1.2, k * 0.055);
  ctx.strokeStyle = c.dark;
  ctx.lineJoin = 'round';
  // Body: flared base up to the neck.
  ctx.beginPath();
  ctx.moveTo(-k * 0.34, k * 0.26);
  ctx.bezierCurveTo(-k * 0.36, k * 0.1, -k * 0.12, k * 0.04, -k * 0.13, -k * 0.16);
  ctx.lineTo(k * 0.13, -k * 0.16);
  ctx.bezierCurveTo(k * 0.12, k * 0.04, k * 0.36, k * 0.1, k * 0.34, k * 0.26);
  ctx.quadraticCurveTo(0, k * 0.4, -k * 0.34, k * 0.26);
  ctx.closePath();
  ctx.fillStyle = c.hex;
  ctx.fill();
  ctx.stroke();
  // Collar.
  ctx.beginPath();
  ctx.ellipse(0, -k * 0.15, k * 0.17, k * 0.06, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // Head.
  ctx.beginPath();
  ctx.arc(0, -k * 0.36, k * 0.2, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // Symbol for colorblind players.
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  symbolPath(ctx, c.symbol, 0, -k * 0.35, k * 0.1);
  ctx.fill();
  // Highlights.
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(-k * 0.08, -k * 0.45, k * 0.06, k * 0.04, -0.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-k * 0.2, k * 0.17, k * 0.05, k * 0.08, 0.5, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function polyPath(ctx, pts, T) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const q = T(p);
    ctx[i ? 'lineTo' : 'moveTo'](q.x, q.y);
  });
  ctx.closePath();
}

export class BoardView {
  constructor(canvas, { gestures = 'auto' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cache = document.createElement('canvas');
    this.cctx = this.cache.getContext('2d');
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.viewTween = null;
    this.boardDirty = true;
    this.gesturesOpt = gestures;
    this.pointers = new Map();
    this.onTap = null;
    this.onPress = null;
    this.onRelease = null;
    this.onViewChange = null;
    this.seatColors = [];
    this._bindGestures();
  }

  // `pov`: seat to draw in the bottom-left corner (null keeps the default orientation).
  setBoard(n, seatColors, pov = null) {
    this.n = n;
    this.board = rotateBoard(buildBoard(n), povSteps(n, pov));
    this.seatColors = distinctColors(n, seatColors || []);
    this.gestures = this.gesturesOpt === 'auto' ? n >= 6 : !!this.gesturesOpt;
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.boardDirty = true;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 300;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.cache.width = pw;
      this.cache.height = ph;
    }
    if (this.board) {
      const b = this.board.bounds;
      const bw = b.maxX - b.minX + 0.8, bh = b.maxY - b.minY + 1.2;
      this.fit = Math.min(w / bw, h / bh);
    }
    this.boardDirty = true;
  }

  get u() {
    return this.fit * this.zoom;
  }

  T = (p) => ({ x: this.w / 2 + (p.x + this.panX) * this.u, y: this.h / 2 + (p.y + this.panY) * this.u });

  toWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.u - this.panX, y: (sy - this.h / 2) / this.u - this.panY };
  }

  clampPan() {
    const b = this.board.bounds;
    const limX = Math.max(0, (b.maxX - b.minX) / 2 - this.w / (2 * this.u));
    const limY = Math.max(0, (b.maxY - b.minY) / 2 - this.h / (2 * this.u));
    this.panX = Math.max(-limX, Math.min(limX, this.panX));
    this.panY = Math.max(-limY, Math.min(limY, this.panY));
  }

  setView(zoom, panX, panY) {
    this.zoom = Math.max(1, Math.min(2.6, zoom));
    this.panX = panX;
    this.panY = panY;
    this.clampPan();
    this.boardDirty = true;
    this.onViewChange?.();
  }

  // Smoothly center the view on a world point (used to follow the active arm on big boards).
  focusOn(p, zoom, ms = 450) {
    if (!this.gestures) return;
    const z = Math.max(1, Math.min(2.6, zoom));
    const saved = [this.zoom, this.panX, this.panY];
    this.zoom = z;
    this.panX = -p.x;
    this.panY = -p.y;
    this.clampPan();
    const target = [this.zoom, this.panX, this.panY];
    [this.zoom, this.panX, this.panY] = saved;
    this.viewTween = { from: saved, to: target, t: 0, ms };
  }

  // Advance view tweens; returns true while animating.
  update(dt) {
    if (!this.viewTween) return false;
    const vt = this.viewTween;
    vt.t = Math.min(1, vt.t + dt / vt.ms);
    const e = 1 - Math.pow(1 - vt.t, 3);
    const lerp = (i) => vt.from[i] + (vt.to[i] - vt.from[i]) * e;
    this.zoom = lerp(0);
    this.panX = lerp(1);
    this.panY = lerp(2);
    this.boardDirty = true;
    if (vt.t >= 1) this.viewTween = null;
    return true;
  }

  _bindGestures() {
    const c = this.canvas;
    let start = null;
    let pinch = null;
    let moved = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      if (this.pointers.size === 1) {
        start = { ...pos(e), panX: this.panX, panY: this.panY, time: performance.now() };
        moved = false;
        this.onPress?.(pos(e));
      } else if (this.pointers.size === 2 && this.gestures) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        pinch.world = this.toWorld(pinch.mid.x, pinch.mid.y);
        moved = true;
        this.onRelease?.(null);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, pos(e));
      if (pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z = Math.max(1, Math.min(2.6, pinch.zoom * (d / pinch.d)));
        const u = this.fit * z;
        this.viewTween = null;
        this.setView(z, (mid.x - this.w / 2) / u - pinch.world.x, (mid.y - this.h / 2) / u - pinch.world.y);
      } else if (start) {
        const p = pos(e);
        const dx = p.x - start.x, dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) > 10) {
          moved = true;
          if (this.gestures && this.zoom > 1.01) this.onRelease?.(null);
        }
        if (moved && this.gestures && this.zoom > 1.01) {
          this.viewTween = null;
          this.setView(this.zoom, start.panX + dx / this.u, start.panY + dy / this.u);
        }
      }
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) pinch = null;
      if (this.pointers.size === 0 && start) {
        const panned = moved && this.gestures && this.zoom > 1.01;
        this.onRelease?.(panned ? null : p);
        if (!panned && e.type === 'pointerup') this.onTap?.(p);
        start = null;
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      if (!this.gestures) return;
      e.preventDefault();
      const p = pos(e);
      const world = this.toWorld(p.x, p.y);
      const z = Math.max(1, Math.min(2.6, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const u = this.fit * z;
      this.viewTween = null;
      this.setView(z, (p.x - this.w / 2) / u - world.x, (p.y - this.h / 2) / u - world.y);
    }, { passive: false });
  }

  drawBoardCache() {
    const ctx = this.cctx;
    const { board } = this;
    const u = this.u;
    const T = this.T;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const col = (s) => colorOf(this.seatColors[s] ?? s);

    // Board base with a drop shadow.
    ctx.save();
    ctx.shadowColor = 'rgba(0,10,40,0.45)';
    ctx.shadowBlur = u * 0.7;
    ctx.shadowOffsetY = u * 0.2;
    polyPath(ctx, board.outline, T);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    const line = Math.max(1, u * 0.03);

    // Yards: solid color with a white inner square; slots are plain colored discs.
    board.yards.forEach((y, s) => {
      const c = col(s);
      polyPath(ctx, y.poly, T);
      ctx.fillStyle = c.hex;
      ctx.fill();
      ctx.lineWidth = line;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
      const cen = T(y.center);
      const h = y.innerHalf * u;
      ctx.save();
      ctx.translate(cen.x, cen.y);
      ctx.rotate(y.rot);
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, -h, -h, 2 * h, 2 * h, h * 0.05);
      ctx.fill();
      ctx.restore();
      const sr = Math.min(y.slotR * 0.62, 0.45) * u;
      for (const sl of y.slots) {
        const p = T(sl);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sr, 0, TAU);
        ctx.fillStyle = c.hex;
        ctx.fill();
      }
    });

    // Track and home-column squares.
    const square = (p, fill) => {
      const q = T(p);
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = fill;
      ctx.fillRect(-u / 2, -u / 2, u, u);
      ctx.lineWidth = line;
      ctx.strokeStyle = GRID;
      ctx.strokeRect(-u / 2, -u / 2, u, u);
      ctx.restore();
      return q;
    };
    for (const t of board.track) {
      const q = square(t, t.start >= 0 ? col(t.start).hex : '#ffffff');
      if (t.star && t.start < 0) {
        ctx.fillStyle = '#ffffff';
        starPath(ctx, q.x, q.y, u * 0.36, u * 0.16, 5);
        ctx.fill();
        ctx.lineWidth = Math.max(1, u * 0.04);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#8a8a92';
        ctx.stroke();
      }
      if (t.entry >= 0) {
        const arm = board.arms[t.entry];
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(Math.atan2(-arm.e.y, -arm.e.x));
        ctx.strokeStyle = col(t.entry).hex;
        ctx.lineWidth = Math.max(1.2, u * 0.06);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-u * 0.3, 0);
        ctx.lineTo(u * 0.3, 0);
        ctx.moveTo(u * 0.12, -u * 0.17);
        ctx.lineTo(u * 0.3, 0);
        ctx.lineTo(u * 0.12, u * 0.17);
        ctx.stroke();
        ctx.restore();
      }
    }
    board.homeCol.forEach((colSq, s) => colSq.forEach((p) => square(p, col(s).hex)));

    // Center home triangles (stroked in their own color to hide seams).
    board.center.tris.forEach((tri, s) => {
      polyPath(ctx, tri, T);
      ctx.fillStyle = col(s).hex;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = col(s).hex;
      ctx.stroke();
    });

    polyPath(ctx, board.outline, T);
    ctx.lineWidth = Math.max(1, u * 0.04);
    ctx.strokeStyle = '#6d6d78';
    ctx.stroke();
    this.boardDirty = false;
  }

  // Player names in each yard's colored border: above/below on the square board,
  // on the inner (center-facing) side on 6/8-player boards.
  drawYardLabels(ctx, labels) {
    const u = this.u;
    const n = this.board.n;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    labels.forEach((text, s) => {
      if (!text) return;
      const y = this.board.yards[s];
      const band = y.innerHalf / 0.7;
      const size = Math.max(9, u * (n === 4 ? 0.62 : 0.46));
      ctx.font = `700 ${Math.round(size)}px Fredoka, system-ui, sans-serif`;
      let p;
      if (n === 4) {
        const dir = y.center.y < 0 ? -1 : 1;
        p = { x: y.center.x, y: y.center.y + dir * (y.innerHalf + (band - y.innerHalf) / 2) };
      } else {
        const len = Math.hypot(y.center.x, y.center.y) || 1;
        const ux = -y.center.x / len, uy = -y.center.y / len;
        const hw = ctx.measureText(text).width / u / 2, hh = size / u / 2;
        const d = y.innerHalf * 1.3 + 0.15 + Math.abs(ux) * hw + Math.abs(uy) * hh;
        p = { x: y.center.x + ux * d, y: y.center.y + uy * d };
      }
      const q = this.T(p);
      ctx.lineWidth = Math.max(2, size * 0.22);
      ctx.strokeStyle = 'rgba(10,20,50,0.85)';
      ctx.strokeText(text, q.x, q.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, q.x, q.y);
    });
    ctx.restore();
  }

  // scene: { tokens: [...], under?: fn(ctx, view), over?: fn(ctx, view) }
  draw(scene = {}) {
    if (!this.board) return;
    if (this.boardDirty) this.drawBoardCache();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (scene.labels) this.drawYardLabels(ctx, scene.labels);
    scene.under?.(ctx, this);
    const tokens = scene.tokens || [];
    const sorted = [...tokens].sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.y - b.y);
    for (const t of sorted) {
      const q = this.T(t);
      drawPawn(ctx, q.x, q.y, this.u, t.color, t);
    }
    for (const b of scene.badges || []) {
      const q = this.T(b);
      const r = this.u * 0.2;
      const bx = q.x + this.u * 0.32, by = q.y - this.u * 0.8;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.u * 0.05);
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.font = `700 ${Math.round(r * 1.3)}px Fredoka, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.count), bx, by + 1);
    }
    scene.over?.(ctx, this);
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Lay out tokens resting on cells: stacks fan out sideways with a count badge.
export function layoutTokens(board, items) {
  const groups = new Map();
  const out = [];
  const badges = [];
  for (const it of items) {
    if (it.free) { out.push(it); continue; }
    const key = it.cellKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const list of groups.values()) {
    if (list.length === 1 || list[0].cellKey.startsWith('y') || list[0].cellKey.startsWith('h')) {
      out.push(...list);
      continue;
    }
    const m = list.length;
    const spread = Math.min(0.3, 0.75 / m);
    const shrink = m === 2 ? 0.74 : 0.62;
    list.forEach((it, i) => {
      const off = (i - (m - 1) / 2) * spread;
      out.push({ ...it, x: it.x + off, y: it.y + 0.06, scale: (it.scale ?? 1) * shrink, z: (it.z ?? 0) + i * 0.01 });
    });
    if (m >= 4) badges.push({ x: list[0].x + spread * (m - 1) / 2, y: list[0].y, count: m });
  }
  return { tokens: out, badges };
}
