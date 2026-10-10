// Code-drawn theme art: tiled backdrop pattern, home tile illustrations, and the logo scene.
import { drawPawn, drawClassicPawn, roundRect } from '../board/render.js';

const TAU = Math.PI * 2;
const RED = 0, GREEN = 1, YELLOW = 2, BLUE = 3;

function hiDpi(canvas, w, hgt) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return ctx;
}

// Faint tilted boards and dice, exported as a repeating CSS background.
export function paintBackdrop() {
  const S = 260;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,0.075)';
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 3;
  const board = (x, y, s, a) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.08);
    ctx.stroke();
    const q = s * 0.4;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      roundRect(ctx, dx * s * 0.3 - q / 2, dy * s * 0.3 - q / 2, q, q, q * 0.15);
      ctx.fill();
    }
    ctx.restore();
  };
  const die = (x, y, s, a, v) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.22);
    ctx.stroke();
    const pips = { 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]] }[v];
    for (const [px, py] of pips) {
      ctx.beginPath();
      ctx.arc(px * s * 0.25, py * s * 0.25, s * 0.08, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };
  board(60, 70, 80, 0.35);
  board(195, 195, 70, -0.3);
  die(190, 60, 38, 0.5, 5);
  die(60, 200, 34, -0.4, 3);
  die(130, 130, 22, 0.9, 2);
  // Wrap the edge-crossing shapes so tiles join seamlessly.
  board(195 - S, 195, 70, -0.3);
  board(195, 195 - S, 70, -0.3);
  document.documentElement.style.setProperty('--backdrop', `url(${c.toDataURL()})`);
}

// ---------- tile illustrations ----------
const ART = {
  create(ctx, w, hgt) {
    const cx = w * 0.5, cy = hgt * 0.46, r = hgt * 0.34;
    const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#9be7ff');
    g.addColorStop(1, '#1673d1');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.45, r, 0, 0, TAU);
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx - r * 0.87, cy - r * 0.5); ctx.lineTo(cx + r * 0.87, cy - r * 0.5);
    ctx.moveTo(cx - r * 0.87, cy + r * 0.5); ctx.lineTo(cx + r * 0.87, cy + r * 0.5);
    ctx.stroke();
    ctx.fillStyle = '#3fbf5a';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.3, cy - r * 0.2, r * 0.28, r * 0.2, 0.5, 0, TAU);
    ctx.ellipse(cx + r * 0.35, cy + r * 0.3, r * 0.22, r * 0.3, -0.3, 0, TAU);
    ctx.fill();
    drawPawn(ctx, w * 0.22, hgt * 0.86, hgt * 0.42, RED);
    drawPawn(ctx, w * 0.78, hgt * 0.86, hgt * 0.42, YELLOW);
  },
  team(ctx, w, hgt) {
    const u = hgt * 0.44;
    drawPawn(ctx, w * 0.2, hgt * 0.84, u, RED);
    drawPawn(ctx, w * 0.36, hgt * 0.9, u, YELLOW);
    drawPawn(ctx, w * 0.64, hgt * 0.9, u, GREEN);
    drawPawn(ctx, w * 0.8, hgt * 0.84, u, BLUE);
    vsBadge(ctx, w * 0.5, hgt * 0.38, hgt * 0.17);
  },
  join(ctx, w, hgt) {
    const cw = w * 0.56, ch = hgt * 0.5, x = w * 0.5 - cw / 2, y = hgt * 0.14;
    ctx.save();
    ctx.translate(w * 0.5, y + ch / 2);
    ctx.rotate(-0.08);
    ctx.translate(-w * 0.5, -(y + ch / 2));
    ctx.fillStyle = '#0d2e6e';
    roundRect(ctx, x, y + 3, cw, ch, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, cw, ch, 8);
    ctx.fill();
    ctx.fillStyle = '#1b5fc1';
    ctx.font = `700 ${Math.round(ch * 0.42)}px Fredoka, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A1B2', w * 0.5, y + ch * 0.52);
    ctx.restore();
    drawPawn(ctx, w * 0.24, hgt * 0.9, hgt * 0.4, GREEN);
    drawPawn(ctx, w * 0.76, hgt * 0.9, hgt * 0.4, BLUE);
  },
  computer(ctx, w, hgt) {
    const pw = hgt * 0.5, ph = hgt * 0.82, x = w * 0.5 - pw / 2, y = hgt * 0.08;
    ctx.fillStyle = '#1d2235';
    roundRect(ctx, x, y, pw, ph, pw * 0.16);
    ctx.fill();
    const sg = ctx.createLinearGradient(0, y, 0, y + ph);
    sg.addColorStop(0, '#5ad1ff');
    sg.addColorStop(1, '#1f6fe0');
    ctx.fillStyle = sg;
    roundRect(ctx, x + pw * 0.09, y + ph * 0.08, pw * 0.82, ph * 0.82, pw * 0.08);
    ctx.fill();
    robot(ctx, w * 0.5, y + ph * 0.3, pw * 0.26);
    vsBadge(ctx, w * 0.5, y + ph * 0.68, pw * 0.2);
    drawPawn(ctx, w * 0.2, hgt * 0.9, hgt * 0.42, RED);
    drawPawn(ctx, w * 0.8, hgt * 0.9, hgt * 0.42, GREEN);
  },
  pass(ctx, w, hgt) {
    person(ctx, w * 0.24, hgt * 0.52, hgt * 0.3, '#ff7a3d');
    person(ctx, w * 0.76, hgt * 0.52, hgt * 0.3, '#2fb35a');
    const pw = hgt * 0.3, ph = hgt * 0.48;
    ctx.save();
    ctx.translate(w * 0.5, hgt * 0.52);
    ctx.rotate(-0.25);
    ctx.fillStyle = '#1d2235';
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, pw * 0.18);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, -pw * 0.38, -ph * 0.4, pw * 0.76, ph * 0.8, pw * 0.08);
    ctx.fill();
    for (const [i, col] of ['#EE1C25', '#0FA046', '#FFD500', '#20A2EA'].entries()) {
      ctx.fillStyle = col;
      ctx.fillRect(-pw * 0.34 + (i % 2) * pw * 0.36, -ph * 0.36 + Math.floor(i / 2) * ph * 0.37, pw * 0.32, ph * 0.33);
    }
    ctx.restore();
    ctx.strokeStyle = '#ffd34a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    arrowArc(ctx, w * 0.5, hgt * 0.55, hgt * 0.42, -2.5, -0.65);
    arrowArc(ctx, w * 0.5, hgt * 0.5, hgt * 0.42, 0.65, 2.5);
  },
};

function vsBadge(ctx, x, y, r) {
  ctx.fillStyle = '#ffcc1f';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.strokeStyle = '#a3560a';
  ctx.stroke();
  ctx.fillStyle = '#7a1d00';
  ctx.font = `800 ${Math.round(r * 1.05)}px Fredoka, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('VS', x, y + r * 0.06);
}

function robot(ctx, x, y, s) {
  ctx.fillStyle = '#e9edf5';
  roundRect(ctx, x - s, y - s * 0.75, s * 2, s * 1.5, s * 0.4);
  ctx.fill();
  ctx.strokeStyle = '#e9edf5';
  ctx.lineWidth = Math.max(1.5, s * 0.15);
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.75); ctx.lineTo(x, y - s * 1.15);
  ctx.stroke();
  ctx.fillStyle = '#ff4d5a';
  ctx.beginPath();
  ctx.arc(x, y - s * 1.2, s * 0.17, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#1f6fe0';
  for (const dx of [-0.45, 0.45]) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y - s * 0.1, s * 0.22, 0, TAU);
    ctx.fill();
  }
  ctx.fillRect(x - s * 0.4, y + s * 0.35, s * 0.8, s * 0.12);
}

function person(ctx, x, y, s, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x, y - s * 0.55, s * 0.42, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - s * 0.75, y + s * 1.2);
  ctx.quadraticCurveTo(x - s * 0.75, y, x, y);
  ctx.quadraticCurveTo(x + s * 0.75, y, x + s * 0.75, y + s * 1.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(x - s * 0.14, y - s * 0.7, s * 0.13, 0, TAU);
  ctx.fill();
}

function arrowArc(ctx, x, y, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(x, y, r, a0, a1);
  ctx.stroke();
  const ex = x + Math.cos(a1) * r, ey = y + Math.sin(a1) * r;
  const t = a1 + Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(ex + Math.cos(t - 2.5) * 7, ey + Math.sin(t - 2.5) * 7);
  ctx.lineTo(ex, ey);
  ctx.lineTo(ex + Math.cos(t + 2.5) * 7, ey + Math.sin(t + 2.5) * 7);
  ctx.stroke();
}

export function drawTileIcon(canvas, kind) {
  const w = 140, hgt = 100;
  const ctx = hiDpi(canvas, w, hgt);
  ART[kind]?.(ctx, w, hgt);
}

// ---------- logo scene ----------
// A tilted board, a die and four classic pawns. `big` canvases get the wide scene.
export function drawLogo(canvas) {
  const big = canvas.classList.contains('big');
  const w = big ? 320 : 180, hgt = big ? 170 : 160;
  const ctx = hiDpi(canvas, w, hgt);
  const cx = w / 2, cy = big ? 92 : 84;
  const s = big ? 120 : 104;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.55);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = 'rgba(0,10,40,0.35)';
  roundRect(ctx, -s / 2 + 8, -s / 2 + 8, s, s, 10);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, -s / 2, -s / 2, s, s, 10);
  ctx.fill();
  const q = s * 0.4;
  const cols = ['#EE1C25', '#0FA046', '#20A2EA', '#FFD500'];
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy], i) => {
    ctx.fillStyle = cols[i];
    ctx.fillRect(dx < 0 ? -s / 2 + 4 : s / 2 - 4 - q, dy < 0 ? -s / 2 + 4 : s / 2 - 4 - q, q, q);
    ctx.fillStyle = '#ffffff';
    const iq = q * 0.6;
    ctx.fillRect((dx < 0 ? -s / 2 + 4 : s / 2 - 4 - q) + q * 0.2, (dy < 0 ? -s / 2 + 4 : s / 2 - 4 - q) + q * 0.2, iq, iq);
  });
  const t = s * 0.1;
  for (const [i, a] of [0, 1, 3, 2].entries()) {
    ctx.save();
    ctx.rotate((a * Math.PI) / 2);
    ctx.fillStyle = cols[i];
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-t, -t); ctx.lineTo(t, -t);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  const k = big ? 46 : 40;
  drawClassicPawn(ctx, cx - k * 1.35, cy + k * 0.15, k, RED);
  drawClassicPawn(ctx, cx - k * 0.45, cy + k * 0.55, k, GREEN);
  drawClassicPawn(ctx, cx + k * 0.45, cy + k * 0.55, k, YELLOW);
  drawClassicPawn(ctx, cx + k * 1.35, cy + k * 0.15, k, BLUE);
  if (big) logoDie(ctx, w - 44, 46, 34, 0.35);
  else logoDie(ctx, w - 30, 34, 26, 0.35);
}

function logoDie(ctx, x, y, s, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = '#b9bcc6';
  roundRect(ctx, -s / 2, -s / 2 + s * 0.1, s, s, s * 0.2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.2);
  ctx.fill();
  ctx.fillStyle = '#16181f';
  for (const [px, py] of [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]) {
    ctx.beginPath();
    ctx.arc(px * s * 0.25, py * s * 0.25, s * 0.085, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// Splits the title into individually colored letters.
export function colorTitle(el, text) {
  if (el.closest('.ball-title')) return ballTitle(el, text);
  const cols = ['#ff4b55', '#33d16a', '#ffd21f', '#3fb4ff'];
  let i = 0;
  el.replaceChildren(...[...text].map((ch) => {
    const span = document.createElement('span');
    span.textContent = ch;
    if (ch.trim()) span.style.setProperty('--lc', cols[i++ % cols.length]);
    else span.className = 'sp';
    return span;
  }));
  el.setAttribute('aria-label', text);
}

// Home logo: first word as letters on white balls, the rest as a small gold tag.
function ballTitle(el, text) {
  const cols = ['#e31b23', '#0e9a42', '#f0a300', '#1580dc'];
  const [first, ...rest] = text.trim().split(/\s+/);
  const balls = [...first].map((ch, i) => {
    const span = document.createElement('span');
    span.className = 'ball';
    span.textContent = ch;
    span.style.setProperty('--lc', cols[i % cols.length]);
    return span;
  });
  const parts = [...balls];
  if (rest.length) {
    const tag = document.createElement('span');
    tag.className = 'word-tag';
    tag.textContent = rest.join(' ');
    parts.push(tag);
  }
  el.replaceChildren(...parts);
  el.setAttribute('aria-label', text);
}
