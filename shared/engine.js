// Pure Ludo rules engine. Every action takes a state and returns { state, events }
// without mutating the input. Dice values are injected by the caller.
import {
  TOKENS, DEFAULT_OPTS, lastTrack, colStart, homeProgress, cellOf, nextProgress,
  isSafe, teamOf, stepsToHome,
} from './rules.js';

const clone = (s) => (typeof structuredClone === 'function' ? structuredClone(s) : JSON.parse(JSON.stringify(s)));

export function createGame({ n, seats = [], opts = {}, firstTurn = 0 }) {
  if (![4, 6, 8].includes(n)) throw new Error('n must be 4, 6 or 8');
  const o = { ...DEFAULT_OPTS, ...opts };
  const players = [];
  for (let s = 0; s < n; s++) {
    const seat = seats[s] || {};
    players.push({
      seat: s,
      active: seat.active !== false,
      color: seat.color ?? s,
      team: o.teamMode ? (seat.team === 0 || seat.team === 1 ? seat.team : teamOf(s)) : s,
      tokens: Array(TOKENS).fill(o.quickMode ? 0 : -1),
      done: false,
      captured: false,
    });
  }
  const st = {
    n, opts: o, players, turn: 0, phase: 'roll', dice: null, sixes: 0,
    legal: [], ranks: [], over: false, moves: 0,
  };
  if (players.filter((p) => p.active).length < 2) throw new Error('need at least 2 active seats');
  st.turn = firstTurn;
  if (!canTakeTurn(st, firstTurn)) st.turn = findNext(st, firstTurn);
  return st;
}

export const isOpponent = (st, a, b) => a !== b && st.players[a].team !== st.players[b].team;
// Captures and blockades apply between any two seats, teammates included.
const isRival = (a, b) => a !== b;

export function teamMembers(st, team) {
  return st.players.filter((p) => p.active && p.team === team);
}

export function teamDone(st, team) {
  return teamMembers(st, team).every((p) => p.done);
}

function canTakeTurn(st, s) {
  const p = st.players[s];
  if (!p.active) return false;
  if (!p.done) return true;
  return st.opts.teamMode && st.opts.assist && !teamDone(st, p.team);
}

function findNext(st, from) {
  for (let i = 1; i <= st.n; i++) {
    const s = (from + i) % st.n;
    if (canTakeTurn(st, s)) return s;
  }
  return from;
}

// Seats whose tokens the current player may move.
export function controllableSeats(st, mover = st.turn) {
  const p = st.players[mover];
  if (!p.done) return [mover];
  if (st.opts.teamMode && st.opts.assist) {
    return teamMembers(st, p.team).filter((q) => !q.done).map((q) => q.seat);
  }
  return [];
}

function tokensOnTrack(st, abs) {
  const out = [];
  for (const p of st.players) {
    if (!p.active) continue;
    p.tokens.forEach((prog, t) => {
      const c = cellOf(st.n, p.seat, prog);
      if (c.k === 't' && c.i === abs) out.push({ seat: p.seat, token: t });
    });
  }
  return out;
}

function hasOpponentBlockade(st, owner, abs) {
  const counts = new Map();
  for (const tk of tokensOnTrack(st, abs)) {
    if (!isRival(owner, tk.seat)) continue;
    const c = (counts.get(tk.seat) || 0) + 1;
    if (c >= 2) return true;
    counts.set(tk.seat, c);
  }
  return false;
}

// Path of cells a token visits for a given roll, or null if the move is illegal.
export function computeMove(st, owner, token, dice) {
  const n = st.n;
  const p = st.players[owner];
  const from = p.tokens[token];
  const H = homeProgress(n);
  if (from === H) return null;
  const canEnter = !st.opts.captureToEnterHome || p.captured;
  let to;
  const path = [];
  if (from < 0) {
    if (dice !== 6) return null;
    to = 0;
    path.push(cellOf(n, owner, 0));
  } else {
    let cur = from;
    for (let i = 0; i < dice; i++) {
      if (cur === H) return null;
      cur = nextProgress(n, cur, canEnter);
      path.push(cellOf(n, owner, cur));
    }
    to = cur;
  }
  if (st.opts.blockades) {
    for (const c of path) if (c.k === 't' && hasOpponentBlockade(st, owner, c.i)) return null;
  }
  return { to, path };
}

export function legalMoves(st) {
  if (st.over || st.dice == null) return [];
  const out = [];
  for (const owner of controllableSeats(st)) {
    const tokens = st.players[owner].tokens;
    for (let t = 0; t < TOKENS; t++) {
      const m = computeMove(st, owner, t, st.dice);
      if (m) out.push({ seat: owner, token: t, from: tokens[t], to: m.to });
    }
  }
  return out;
}

// Moves that are genuinely different (tokens stacked on the same square are interchangeable).
export function distinctMoves(legal) {
  const seen = new Set();
  return legal.filter((m) => {
    const k = `${m.seat}:${m.from}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function endTurn(st, ev) {
  st.sixes = 0;
  st.dice = null;
  st.legal = [];
  st.phase = 'roll';
  const prev = st.turn;
  st.turn = findNext(st, prev);
  ev.push({ t: 'turnChanged', seat: st.turn, prev });
}

export function roll(state, value) {
  if (state.over) throw new Error('game over');
  if (state.phase !== 'roll') throw new Error('not in roll phase');
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('bad dice value');
  const st = clone(state);
  const seat = st.turn;
  const ev = [{ t: 'rolled', seat, value }];
  st.dice = value;
  st.sixes = value === 6 ? st.sixes + 1 : 0;
  if (st.sixes === 3) {
    ev.push({ t: 'forfeit', seat });
    endTurn(st, ev);
    return { state: st, events: ev };
  }
  st.legal = legalMoves(st);
  if (st.legal.length === 0) {
    // No usable move ends the turn, even on a 6.
    ev.push({ t: 'noMoves', seat });
    endTurn(st, ev);
  } else {
    st.phase = 'move';
  }
  return { state: st, events: ev };
}

function playerScore(st, p) {
  const H = homeProgress(st.n);
  const home = p.tokens.filter((x) => x === H).length;
  const dist = p.tokens.reduce((a, x) => a + stepsToHome(st.n, x), 0);
  return home * 1000 - dist;
}

function finalizeRanks(st) {
  if (st.opts.teamMode) {
    const teams = [...new Set(st.players.filter((p) => p.active).map((p) => p.team))];
    const rest = teams.filter((t) => !st.ranks.includes(t));
    const tScore = (t) => teamMembers(st, t).reduce((a, p) => a + playerScore(st, p), 0);
    rest.sort((a, b) => tScore(b) - tScore(a));
    st.ranks.push(...rest);
  } else {
    const rest = st.players.filter((p) => p.active && !st.ranks.includes(p.seat));
    rest.sort((a, b) => playerScore(st, b) - playerScore(st, a));
    st.ranks.push(...rest.map((p) => p.seat));
  }
}

function checkGameOver(st, ev) {
  const H = homeProgress(st.n);
  const q = st.opts.quickMode;
  let over = false;
  if (q) {
    if (st.opts.teamMode) {
      for (const team of new Set(st.players.filter((p) => p.active).map((p) => p.team))) {
        const members = teamMembers(st, team);
        const home = members.reduce((a, p) => a + p.tokens.filter((x) => x === H).length, 0);
        if (home >= q * members.length && !st.ranks.includes(team)) { st.ranks.push(team); over = true; }
      }
    } else {
      for (const p of st.players) {
        if (p.active && p.tokens.filter((x) => x === H).length >= q && !st.ranks.includes(p.seat)) {
          st.ranks.push(p.seat);
          over = true;
        }
      }
    }
  } else if (st.opts.teamMode) {
    const teams = new Set(st.players.filter((p) => p.active).map((p) => p.team));
    over = [...teams].filter((t) => !teamDone(st, t)).length <= 1;
  } else {
    over = st.players.filter((p) => p.active && !p.done).length <= 1;
  }
  if (!over) return false;
  finalizeRanks(st);
  st.over = true;
  st.phase = 'over';
  st.dice = null;
  st.legal = [];
  ev.push({ t: 'gameOver', ranks: [...st.ranks], team: st.opts.teamMode });
  return true;
}

export function move(state, { seat, token }) {
  if (state.over) throw new Error('game over');
  if (state.phase !== 'move') throw new Error('not in move phase');
  const legal = state.legal.find((m) => m.seat === seat && m.token === token);
  if (!legal) throw new Error('illegal move');
  const st = clone(state);
  const n = st.n;
  const mover = st.turn;
  const owner = st.players[seat];
  const m = computeMove(st, seat, token, st.dice);
  const from = owner.tokens[token];
  owner.tokens[token] = m.to;
  st.moves++;
  const ev = [{ t: 'moved', seat, token, by: mover, from, to: m.to, path: m.path, exit: from < 0 }];

  let captured = false;
  const dest = m.path[m.path.length - 1];
  if (dest.k === 't' && !isSafe(n, dest.i)) {
    const bySeat = new Map();
    for (const tk of tokensOnTrack(st, dest.i)) {
      if (isRival(seat, tk.seat)) bySeat.set(tk.seat, [...(bySeat.get(tk.seat) || []), tk]);
    }
    for (const tks of bySeat.values()) {
      // Two or more tokens of one player on a square form a pair that can't be captured.
      if (tks.length !== 1) continue;
      const tk = tks[0];
      st.players[tk.seat].tokens[tk.token] = -1;
      captured = true;
      ev.push({ t: 'captured', seat: tk.seat, token: tk.token, by: seat, at: dest.i });
    }
  }
  if (captured) owner.captured = true;

  const H = homeProgress(n);
  const reachedHome = m.to === H;
  if (reachedHome) ev.push({ t: 'reachedHome', seat, token });

  if (!owner.done && owner.tokens.every((x) => x === H)) {
    owner.done = true;
    if (st.opts.teamMode) {
      ev.push({ t: 'playerFinished', seat });
      if (teamDone(st, owner.team) && !st.ranks.includes(owner.team)) {
        st.ranks.push(owner.team);
        ev.push({ t: 'teamFinished', team: owner.team, rank: st.ranks.length });
      }
    } else if (!st.opts.quickMode) {
      st.ranks.push(seat);
      ev.push({ t: 'playerFinished', seat, rank: st.ranks.length });
    }
  }

  if (checkGameOver(st, ev)) return { state: st, events: ev };

  const bonus = st.dice === 6 || captured || reachedHome;
  if (bonus && canTakeTurn(st, mover)) {
    st.dice = null;
    st.legal = [];
    st.phase = 'roll';
    ev.push({ t: 'bonus', seat: mover, reason: captured ? 'capture' : reachedHome ? 'home' : 'six' });
  } else {
    endTurn(st, ev);
  }
  return { state: st, events: ev };
}

// Re-apply engine-visible events (as broadcast by the server) to rebuild a mirror state.
export function applyEvents(state, events) {
  let st = state;
  for (const e of events) {
    if (e.t === 'rolled') st = roll(st, e.value).state;
    else if (e.t === 'moved') st = move(st, { seat: e.seat, token: e.token }).state;
  }
  return st;
}

export { lastTrack, colStart, homeProgress };
