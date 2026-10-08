// Constants and pure helpers shared by client and server.
//
// Token progress model (n = number of arms):
//   -1                yard
//   0 .. L            main track, relative to the owner's start square (L = 13n - 2 is the home-entry square)
//   L + 1             the square just before the start square (only reached by tokens that must lap again)
//   C .. C + 4        home column (C = 13n)
//   H = 13n + 5       home

export const TOKENS = 4;
export const ARM_TRACK = 13;
export const HOME_COL_LEN = 5;
export const START_OFFSET = 8;
export const STAR_OFFSET = 8;
export const PLAYER_COUNTS = [4, 6, 8];
export const YARD = -1;

export const COLORS = [
  { id: 0, name: 'Red', hex: '#EE1C25', dark: '#8E0A10', light: '#FF7A80', symbol: 'circle' },
  { id: 1, name: 'Green', hex: '#0FA046', dark: '#05561F', light: '#6EDB92', symbol: 'square' },
  { id: 2, name: 'Yellow', hex: '#FFD500', dark: '#A07A00', light: '#FFEC80', symbol: 'triangle' },
  { id: 3, name: 'Blue', hex: '#20A2EA', dark: '#0B5A93', light: '#8FD3FF', symbol: 'diamond' },
  { id: 4, name: 'Purple', hex: '#9333EA', dark: '#561896', light: '#C79BF5', symbol: 'star' },
  { id: 5, name: 'Orange', hex: '#FF7A00', dark: '#A04700', light: '#FFB870', symbol: 'hexagon' },
  { id: 6, name: 'Cyan', hex: '#00C2C7', dark: '#00706F', light: '#86EDEF', symbol: 'cross' },
  { id: 7, name: 'Pink', hex: '#F2479A', dark: '#9C1859', light: '#FF9CCB', symbol: 'crescent' },
];

// Default color per seat so adjacent arms always contrast.
export const DEFAULT_SEAT_COLORS = {
  4: [0, 1, 2, 3],
  6: [0, 1, 2, 3, 4, 5],
  8: [0, 1, 2, 3, 4, 5, 6, 7],
};

// One distinct color per seat: seats with a valid, unused color keep it; the rest (empty
// seats, -1) get the seat's default color if free, otherwise the first unused color.
export function seatColors(n, colors) {
  const out = Array(n).fill(-1);
  const used = new Set();
  for (let s = 0; s < n; s++) {
    const c = colors[s];
    if (COLORS[c] && !used.has(c)) { out[s] = c; used.add(c); }
  }
  for (let s = 0; s < n; s++) {
    if (out[s] >= 0) continue;
    const def = DEFAULT_SEAT_COLORS[n][s];
    out[s] = !used.has(def) ? def : COLORS.find((c) => !used.has(c.id)).id;
    used.add(out[s]);
  }
  return out;
}

export const trackLen = (n) => n * ARM_TRACK;
export const lastTrack = (n) => n * ARM_TRACK - 2;
export const colStart = (n) => n * ARM_TRACK;
export const homeProgress = (n) => n * ARM_TRACK + HOME_COL_LEN;

export const startSquare = (seat) => seat * ARM_TRACK + START_OFFSET;
export const starSquare = (n, seat) => (startSquare(seat) + STAR_OFFSET) % trackLen(n);

export function safeSquares(n) {
  const set = new Set();
  for (let s = 0; s < n; s++) {
    set.add(startSquare(s));
    set.add(starSquare(n, s));
  }
  return set;
}

const safeCache = new Map();
export function isSafe(n, abs) {
  let set = safeCache.get(n);
  if (!set) safeCache.set(n, (set = safeSquares(n)));
  return set.has(abs);
}

// Teams: even seats vs odd seats. For 4 players this puts partners opposite each other.
export const teamOf = (seat) => seat % 2;

// Where a token is, as a board cell: yard, main track (absolute index), home column, or home.
export function cellOf(n, seat, p) {
  if (p < 0) return { k: 'y' };
  if (p <= lastTrack(n) + 1) return { k: 't', i: (startSquare(seat) + p) % trackLen(n) };
  if (p < homeProgress(n)) return { k: 'c', i: p - colStart(n) };
  return { k: 'h' };
}

export function nextProgress(n, p, canEnterHome) {
  const L = lastTrack(n);
  if (p === L) return canEnterHome ? colStart(n) : L + 1;
  if (p === L + 1) return 0;
  return p + 1;
}

export function stepsToHome(n, p) {
  if (p < 0) return lastTrack(n) + HOME_COL_LEN + 2;
  if (p <= lastTrack(n)) return lastTrack(n) - p + HOME_COL_LEN + 1;
  if (p === lastTrack(n) + 1) return lastTrack(n) + HOME_COL_LEN + 2;
  return homeProgress(n) - p;
}

// Relative progress a given seat would have when standing on absolute track square `abs`.
export const relProgress = (n, seat, abs) => (abs - startSquare(seat) + trackLen(n)) % trackLen(n);

export const sameCell = (a, b) => a.k === b.k && a.i === b.i;

export const QUICK_CHAT = [
  'Good luck!', 'Nice move!', 'Oops!', 'Hurry up!',
  'Well played!', 'So close!', 'Thanks!', 'Revenge time!',
];
export const EMOJIS = ['😀', '😂', '😮', '😢', '😡', '👍', '🎉', '🔥'];

export const DEFAULT_OPTS = {
  teamMode: false,
  assist: true,
  quickMode: 0,
  blockades: false,
  captureToEnterHome: false,
};
