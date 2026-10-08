// Parametric board generator for n arms (4, 6, 8). All coordinates are in "square units":
// one track square is 1 x 1, and the board is centered on (0, 0) with y pointing down.
//
// Arm k points outward along angle theta_k = PI + 2*PI*k/n (arm 0 points left, then clockwise).
// Within an arm, row r = 0 is next to the center and r = 5 is the outer end. Column c = -1 faces
// arm k-1, c = +1 faces arm k+1, c = 0 is the middle lane (home column).
// Track order per arm: column -1 outward (6), outer middle (1), column +1 inward (6) = 13 squares.
import { ARM_TRACK, START_OFFSET, STAR_OFFSET, HOME_COL_LEN, TOKENS } from './rules.js';

const ARM_ROWS = 6;
const HALF_W = 1.5;

const cache = new Map();

export function buildBoard(n) {
  if (cache.has(n)) return cache.get(n);
  if (![4, 6, 8].includes(n)) throw new Error('n must be 4, 6 or 8');
  const half = Math.PI / n;
  const a = HALF_W / Math.tan(half); // center polygon apothem
  const outer = a + ARM_ROWS; // board outline apothem
  const arms = [];
  for (let k = 0; k < n; k++) {
    const theta = Math.PI + (2 * Math.PI * k) / n;
    const e = { x: Math.cos(theta), y: Math.sin(theta) };
    const f = { x: -e.y, y: e.x };
    arms.push({ theta, e, f });
  }
  const at = (k, r, c) => {
    const { e, f } = arms[k];
    const d = a + r + 0.5;
    return { x: e.x * d + f.x * c, y: e.y * d + f.y * c };
  };

  const track = [];
  for (let k = 0; k < n; k++) {
    for (let l = 0; l < ARM_TRACK; l++) {
      let r, c;
      if (l < 6) { r = l; c = -1; } else if (l === 6) { r = 5; c = 0; } else { r = 12 - l; c = 1; }
      const p = at(k, r, c);
      track.push({
        x: p.x, y: p.y, rot: arms[k].theta, arm: k, local: l,
        start: l === START_OFFSET ? k : -1,
        entry: l === 6 ? k : -1,
        star: false,
      });
    }
  }
  for (let k = 0; k < n; k++) track[(k * ARM_TRACK + START_OFFSET + STAR_OFFSET) % track.length].star = true;

  const homeCol = [];
  for (let k = 0; k < n; k++) {
    const col = [];
    for (let j = 0; j < HOME_COL_LEN; j++) {
      const p = at(k, HOME_COL_LEN - 1 - j, 0);
      col.push({ x: p.x, y: p.y, rot: arms[k].theta });
    }
    homeCol.push(col);
  }

  const yards = [];
  const R = HALF_W / Math.sin(half);
  const kiteDiag = ARM_ROWS / Math.cos(half);
  const tLeg = ARM_ROWS * Math.tan(half);
  const rIn = (ARM_ROWS * tLeg) / (ARM_ROWS + tLeg);
  for (let k = 0; k < n; k++) {
    const phi = arms[k].theta + half;
    const u = { x: Math.cos(phi), y: Math.sin(phi) };
    const V = { x: u.x * R, y: u.y * R };
    const e0 = arms[k].e;
    const e1 = arms[(k + 1) % n].e;
    const poly = [
      V,
      { x: V.x + e0.x * ARM_ROWS, y: V.y + e0.y * ARM_ROWS },
      { x: V.x + u.x * kiteDiag, y: V.y + u.y * kiteDiag },
      { x: V.x + e1.x * ARM_ROWS, y: V.y + e1.y * ARM_ROWS },
    ];
    const cd = rIn / Math.sin(half);
    const center = { x: V.x + u.x * cd, y: V.y + u.y * cd };
    const innerHalf = rIn * 0.7;
    const rot = phi - Math.PI / 4;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const slots = [];
    const off = innerHalf * 0.5;
    for (const [dx, dy] of [[-off, -off], [off, -off], [off, off], [-off, off]]) {
      slots.push({ x: center.x + dx * cs - dy * sn, y: center.y + dx * sn + dy * cs });
    }
    yards.push({ poly, center, innerHalf, rot, slots, slotR: innerHalf * 0.36 });
  }

  const polyVerts = [];
  for (let k = 0; k < n; k++) {
    const phi = arms[k].theta + half;
    polyVerts.push({ x: Math.cos(phi) * R, y: Math.sin(phi) * R });
  }
  const tris = [];
  const homeSlots = [];
  for (let k = 0; k < n; k++) {
    const left = polyVerts[(k - 1 + n) % n];
    const right = polyVerts[k];
    tris.push([{ x: 0, y: 0 }, left, right]);
    const { e, f } = arms[k];
    const slots = [];
    for (let j = 0; j < TOKENS; j++) {
      const d = a * (0.52 + 0.24 * (j >> 1));
      const lat = (j & 1 ? 1 : -1) * d * Math.tan(half) * 0.42;
      slots.push({ x: e.x * d + f.x * lat, y: e.y * d + f.y * lat });
    }
    homeSlots.push(slots);
  }

  const outline = [];
  const outerR = outer / Math.cos(half);
  for (let k = 0; k < n; k++) {
    const phi = arms[k].theta + half;
    outline.push({ x: Math.cos(phi) * outerR, y: Math.sin(phi) * outerR });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }

  const board = {
    n, apothem: a, outer, arms, track, homeCol, yards,
    center: { poly: polyVerts, tris, slots: homeSlots },
    outline, bounds: { minX, minY, maxX, maxY },
  };
  cache.set(n, board);
  return board;
}

// Quarter/sixth/eighth turns needed so `seat`'s yard lands in the bottom-left corner
// (the last yard position, since yards run clockwise from the top-left).
export function povSteps(n, seat) {
  return seat == null || seat < 0 ? 0 : (((n - 1 - seat) % n) + n) % n;
}

const rotCache = new Map();

// The same board turned by `steps` arm positions. Seat indices are unchanged; only where
// each seat is drawn moves.
export function rotateBoard(board, steps) {
  const n = board.n;
  steps = ((steps % n) + n) % n;
  if (!steps) return board;
  const key = `${n}:${steps}`;
  if (rotCache.has(key)) return rotCache.get(key);
  const ang = (2 * Math.PI * steps) / n;
  const c = Math.cos(ang), s = Math.sin(ang);
  const P = (p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  const sq = (p) => ({ ...p, ...P(p), rot: p.rot + ang });
  const outline = board.outline.map(P);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const out = {
    ...board,
    rotation: steps,
    arms: board.arms.map((a) => ({ theta: a.theta + ang, e: P(a.e), f: P(a.f) })),
    track: board.track.map(sq),
    homeCol: board.homeCol.map((col) => col.map(sq)),
    yards: board.yards.map((y) => ({ ...y, poly: y.poly.map(P), center: P(y.center), rot: y.rot + ang, slots: y.slots.map(P) })),
    center: {
      poly: board.center.poly.map(P),
      tris: board.center.tris.map((t) => t.map(P)),
      slots: board.center.slots.map((sl) => sl.map(P)),
    },
    outline,
    bounds: { minX, minY, maxX, maxY },
  };
  rotCache.set(key, out);
  return out;
}

// Board position for a rules-engine cell.
export function cellPos(board, seat, cell, token = 0) {
  switch (cell.k) {
    case 'y': return board.yards[seat].slots[token];
    case 't': return board.track[cell.i];
    case 'c': return board.homeCol[seat][cell.i];
    default: return board.center.slots[seat][token];
  }
}
