// Bot move selection shared by solo mode (browser) and seat-filling bots (server).
import { move as applyMove, isOpponent, distinctMoves, teamMembers } from './engine.js';
import { cellOf, isSafe, lastTrack, relProgress, homeProgress, stepsToHome, trackLen } from './rules.js';

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

// How likely opponents are to hit absolute track square `abs` next turn.
function threatAt(st, owner, abs, hard) {
  const n = st.n;
  if (isSafe(n, abs)) return 0;
  const L = lastTrack(n);
  let threat = 0;
  for (const q of st.players) {
    if (!q.active || !isOpponent(st, owner, q.seat)) continue;
    const tp = relProgress(n, q.seat, abs);
    if (tp > L && !(st.opts.captureToEnterHome && !q.captured)) continue;
    for (const p of q.tokens) {
      if (p < 0) {
        if (hard && tp >= 1 && tp <= 6) threat += 0.12;
        continue;
      }
      if (p > L + 1) continue;
      let d = tp - p;
      if (d <= 0 && st.opts.captureToEnterHome && !q.captured) d += trackLen(n);
      if (d >= 1 && d <= 6) threat += 1;
      else if (hard && d >= 7 && d <= 12) threat += 0.18;
    }
  }
  return threat;
}

function leadingTeam(st) {
  let best = null, bestScore = -Infinity;
  for (const t of new Set(st.players.filter((p) => p.active).map((p) => p.team))) {
    const score = teamMembers(st, t).reduce((a, p) => a + p.tokens.reduce((b, x) => b - stepsToHome(st.n, x), 0), 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

export function scoreMove(st, m, hard = false) {
  const n = st.n;
  const owner = m.seat;
  const { state: next, events } = applyMove(st, m);
  const fromCell = cellOf(n, owner, m.from);
  const toCell = cellOf(n, owner, m.to);
  let s = 0;
  const lead = st.opts.teamMode ? leadingTeam(st) : null;
  for (const e of events) {
    if (e.t === 'captured') {
      s += 100 + stepsToHome(n, -1) - stepsToHome(n, st.players[e.seat].tokens[e.token]) * 0.5;
      if (lead != null && st.players[e.seat].team === lead) s += 35;
    }
    if (e.t === 'reachedHome') s += 90;
  }
  if (m.from < 0) s += 70;
  if (fromCell.k === 't' && toCell.k === 'c') s += 45;
  if (toCell.k === 't' && isSafe(n, toCell.i)) s += 30;
  if (fromCell.k === 't') s += 25 * threatAt(st, owner, fromCell.i, hard);
  if (toCell.k === 't' && !events.some((e) => e.t === 'gameOver')) s -= 60 * threatAt(next, owner, toCell.i, hard);
  // Slight preference for advancing tokens that still have far to go, and finishing runs.
  s += (stepsToHome(n, m.from) - stepsToHome(n, m.to)) * 0.4;
  if (m.to === homeProgress(n) - 1) s -= 3;
  if (st.opts.teamMode && st.opts.blockades && toCell.k === 't') {
    const stacked = next.players[owner].tokens.filter((p) => {
      const c = cellOf(n, owner, p);
      return c.k === 't' && c.i === toCell.i;
    }).length;
    if (stacked >= 2) {
      for (const mate of teamMembers(st, st.players[owner].team)) {
        if (mate.seat === owner) continue;
        const tp = relProgress(n, mate.seat, toCell.i);
        if (mate.tokens.some((p) => p >= 0 && p <= lastTrack(n) && tp - p >= 1 && tp - p <= 6)) s -= 30;
      }
    }
  }
  return s;
}

export function chooseMove(st, difficulty = 'medium', rng = Math.random) {
  const moves = distinctMoves(st.legal);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0];
  if (difficulty === 'easy' && rng() < 0.7) return moves[Math.floor(rng() * moves.length)];
  const hard = difficulty === 'hard';
  const noise = difficulty === 'medium' ? 40 : difficulty === 'easy' ? 80 : 0;
  let best = moves[0], bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(st, m, hard) + (noise ? (rng() - 0.5) * noise : 0);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

export const botDelay = (rng = Math.random) => 600 + Math.floor(rng() * 600);
