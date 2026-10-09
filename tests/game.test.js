import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, roll, move, legalMoves, applyEvents } from '../server/game.js';
import { chooseMove } from '../shared/botcore.js';
import {
  startSquare, starSquare, isSafe, homeProgress, lastTrack, colStart, cellOf, trackLen,
} from '../shared/rules.js';

function game(n = 4, opts = {}, seats) {
  return createGame({ n, opts, seats });
}

function setTokens(st, seat, tokens) {
  st.players[seat].tokens = [...tokens];
  return st;
}

const types = (ev) => ev.map((e) => e.t);

test('a token can only leave the yard on a 6', () => {
  let st = game();
  let r = roll(st, 5);
  assert.deepEqual(types(r.events), ['rolled', 'noMoves', 'turnChanged']);
  assert.equal(r.state.turn, 1);

  st = game();
  r = roll(st, 6);
  assert.equal(r.state.phase, 'move');
  assert.equal(r.state.legal.length, 4);
  r = move(r.state, { seat: 0, token: 2 });
  assert.equal(r.state.players[0].tokens[2], 0);
  assert.deepEqual(cellOf(4, 0, 0), { k: 't', i: startSquare(0) });
  assert.ok(types(r.events).includes('bonus'), 'six grants another roll');
  assert.equal(r.state.turn, 0);
});

test('a 6 with no legal move still grants another roll', () => {
  const st = setTokens(game(), 0, [homeProgress(4), homeProgress(4), homeProgress(4), homeProgress(4) - 1]);
  const r = roll(st, 6);
  assert.deepEqual(types(r.events), ['rolled', 'noMoves', 'bonus']);
  assert.equal(r.state.turn, 0);
});

test('three consecutive sixes forfeit the third move and end the turn', () => {
  let st = setTokens(game(), 0, [10, -1, -1, -1]);
  st = move(roll(st, 6).state, { seat: 0, token: 0 }).state;
  st = move(roll(st, 6).state, { seat: 0, token: 0 }).state;
  assert.equal(st.players[0].tokens[0], 22);
  const r = roll(st, 6);
  assert.deepEqual(types(r.events), ['rolled', 'forfeit', 'turnChanged']);
  assert.equal(r.state.players[0].tokens[0], 22);
  assert.equal(r.state.turn, 1);
  assert.equal(r.state.sixes, 0);
});

test('a non-six resets the six counter', () => {
  let st = setTokens(game(), 0, [10, -1, -1, -1]);
  st = move(roll(st, 6).state, { seat: 0, token: 0 }).state;
  assert.equal(st.sixes, 1);
  const r = roll(st, 3);
  assert.equal(r.state.sixes, 0);
});

test('landing on an opponent captures it and grants a bonus roll', () => {
  let st = game();
  // Seat 1 token sits 3 squares ahead of seat 0's token on the shared track.
  const target = (startSquare(0) + 5) % trackLen(4);
  const p1 = (target - startSquare(1) + trackLen(4)) % trackLen(4);
  setTokens(st, 0, [2, -1, -1, -1]);
  setTokens(st, 1, [p1, -1, -1, -1]);
  assert.ok(!isSafe(4, target));
  const r = move(roll(st, 3).state, { seat: 0, token: 0 });
  assert.deepEqual(types(r.events), ['moved', 'captured', 'bonus']);
  assert.equal(r.state.players[1].tokens[0], -1);
  assert.equal(r.state.players[0].captured, true);
  assert.equal(r.state.turn, 0);
});

test('no captures on safe squares (start and star squares)', () => {
  const n = 4;
  for (const safe of [starSquare(n, 0), startSquare(1)]) {
    const st = game();
    const p0 = (safe - startSquare(0) + trackLen(n)) % trackLen(n);
    const p1 = (safe - startSquare(1) + trackLen(n)) % trackLen(n);
    setTokens(st, 0, [p0 - 4, -1, -1, -1]);
    setTokens(st, 1, [p1, -1, -1, -1]);
    const r = move(roll(st, 4).state, { seat: 0, token: 0 });
    assert.ok(!types(r.events).includes('captured'));
    assert.equal(r.state.players[1].tokens[0], p1);
    assert.equal(r.state.turn, 1);
  }
  assert.ok(isSafe(4, startSquare(2)));
  assert.ok(isSafe(4, starSquare(4, 3)));
  assert.equal(starSquare(4, 0), startSquare(0) + 8);
});

test('exact roll required to reach home', () => {
  const H = homeProgress(4);
  let st = setTokens(game(), 0, [H - 3, -1, -1, -1]);
  let r = roll(st, 4);
  assert.deepEqual(types(r.events), ['rolled', 'noMoves', 'turnChanged']);
  r = roll(st, 3);
  assert.equal(r.state.legal.length, 1);
  r = move(r.state, { seat: 0, token: 0 });
  assert.equal(r.state.players[0].tokens[0], H);
  assert.deepEqual(types(r.events), ['moved', 'reachedHome', 'bonus']);
});

test('tokens turn into the home column after the home-entry square', () => {
  const n = 4;
  const st = setTokens(game(), 0, [lastTrack(n) - 1, -1, -1, -1]);
  const r = move(roll(st, 3).state, { seat: 0, token: 0 });
  assert.equal(r.state.players[0].tokens[0], colStart(n) + 1);
  const kinds = r.events[0].path.map((c) => c.k);
  assert.deepEqual(kinds, ['t', 'c', 'c']);
});

test('blockades stop opponents from passing or landing', () => {
  const opts = { blockades: true };
  const n = 4;
  const sq = (startSquare(0) + 10) % trackLen(n);
  const p1 = (sq - startSquare(1) + trackLen(n)) % trackLen(n);
  let st = game(n, opts);
  setTokens(st, 1, [p1, p1, -1, -1]);
  setTokens(st, 0, [7, -1, -1, -1]);
  assert.equal(roll(st, 5).state.legal.length, 0, 'cannot pass');
  assert.equal(roll(st, 3).state.legal.length, 0, 'cannot land');
  assert.equal(roll(st, 2).state.legal.length, 1, 'can stop short');
  st = game(n, { blockades: false });
  setTokens(st, 1, [p1, p1, -1, -1]);
  setTokens(st, 0, [7, -1, -1, -1]);
  assert.equal(roll(st, 5).state.legal.length, 1, 'no blockade when the rule is off');
});

test('capture required to enter home column makes tokens lap again', () => {
  const n = 4;
  let st = game(n, { captureToEnterHome: true });
  setTokens(st, 0, [lastTrack(n) - 1, -1, -1, -1]);
  let r = move(roll(st, 4).state, { seat: 0, token: 0 });
  assert.equal(r.state.players[0].tokens[0], 1, 'wrapped past the start square');
  assert.ok(r.events[0].path.every((c) => c.k === 't'));
  st = game(n, { captureToEnterHome: true });
  setTokens(st, 0, [lastTrack(n) - 1, -1, -1, -1]);
  st.players[0].captured = true;
  r = move(roll(st, 4).state, { seat: 0, token: 0 });
  assert.equal(r.state.players[0].tokens[0], colStart(n) + 2);
});

test('finishing order is ranked and the game ends when one player remains', () => {
  const H = homeProgress(4);
  let st = game();
  setTokens(st, 0, [H, H, H, H - 2]);
  setTokens(st, 1, [H, H, H, H - 1]);
  setTokens(st, 2, [H, H, H, H - 1]);
  let r = move(roll(st, 2).state, { seat: 0, token: 3 });
  assert.ok(types(r.events).includes('playerFinished'));
  assert.equal(r.state.ranks[0], 0);
  assert.equal(r.state.turn, 1, 'finished player loses the bonus roll');
  r = move(roll(r.state, 1).state, { seat: 1, token: 3 });
  assert.deepEqual(r.state.ranks, [0, 1]);
  r = move(roll(r.state, 1).state, { seat: 2, token: 3 });
  assert.ok(r.state.over);
  assert.deepEqual(r.state.ranks, [0, 1, 2, 3]);
  assert.equal(r.events.at(-1).t, 'gameOver');
});

test('inactive seats are skipped', () => {
  const st = game(6, {}, [{}, { active: false }, {}, { active: false }, { active: false }, {}]);
  let r = roll(st, 2);
  assert.equal(r.state.turn, 2);
  r = roll(r.state, 2);
  assert.equal(r.state.turn, 5);
  r = roll(r.state, 2);
  assert.equal(r.state.turn, 0);
});

test('quick mode: tokens start on board and first to N home wins', () => {
  const H = homeProgress(4);
  let st = game(4, { quickMode: 1 });
  assert.deepEqual(st.players[0].tokens, [0, 0, 0, 0]);
  setTokens(st, 2, [H - 2, 0, 0, 0]);
  st.turn = 2;
  const r = move(roll(st, 2).state, { seat: 2, token: 0 });
  assert.ok(r.state.over);
  assert.equal(r.state.ranks[0], 2);
});

test('team mode: teammates capture each other like anyone else', () => {
  const n = 4;
  const st = game(n, { teamMode: true });
  assert.equal(st.players[0].team, st.players[2].team);
  const target = (startSquare(0) + 20) % trackLen(n);
  assert.ok(!isSafe(n, target));
  setTokens(st, 0, [17, -1, -1, -1]);
  setTokens(st, 2, [(target - startSquare(2) + trackLen(n)) % trackLen(n), -1, -1, -1]);
  const r = move(roll(st, 3).state, { seat: 0, token: 0 });
  assert.ok(types(r.events).includes('captured'));
  assert.equal(r.state.players[2].tokens[0], -1);
});

test('team mode: a teammate blockade blocks you too', () => {
  const n = 4;
  const st = game(n, { teamMode: true, blockades: true });
  const wall = (startSquare(0) + 19) % trackLen(n);
  const rel2 = (wall - startSquare(2) + trackLen(n)) % trackLen(n);
  setTokens(st, 0, [17, 5, -1, -1]);
  setTokens(st, 2, [rel2, rel2, -1, -1]);
  const r = roll(st, 3);
  assert.ok(r.state.legal.some((m) => m.seat === 0 && m.token === 1));
  assert.ok(!r.state.legal.some((m) => m.seat === 0 && m.token === 0), 'cannot pass the partner blockade');
});

test('team bots avoid capturing a partner when another move exists', () => {
  const n = 4;
  const st = game(n, { teamMode: true });
  const target = (startSquare(0) + 20) % trackLen(n);
  setTokens(st, 0, [17, 5, -1, -1]);
  setTokens(st, 2, [(target - startSquare(2) + trackLen(n)) % trackLen(n), -1, -1, -1]);
  const r = roll(st, 3);
  for (const d of ['medium', 'hard']) {
    const m = chooseMove(r.state, d, () => 0.5);
    assert.equal(m.token, 1, `${d} bot moved the other token`);
  }
});

test('team mode: team wins only when all members are home', () => {
  const H = homeProgress(4);
  let st = game(4, { teamMode: true, assist: false });
  setTokens(st, 0, [H, H, H, H - 1]);
  setTokens(st, 2, [H, H, H, H - 5]);
  let r = move(roll(st, 1).state, { seat: 0, token: 3 });
  assert.ok(!r.state.over, 'partner still playing');
  assert.equal(r.state.players[0].done, true);
  r = roll(r.state, 1); // seat 1
  r = move(roll(r.state, 5).state, { seat: 2, token: 3 });
  assert.ok(r.state.over);
  assert.deepEqual(r.state.ranks, [0, 1]);
  assert.equal(r.events.at(-1).team, true);
});

test('team mode 6 and 8 players alternate seats', () => {
  const st6 = game(6, { teamMode: true });
  assert.deepEqual(st6.players.map((p) => p.team), [0, 1, 0, 1, 0, 1]);
  const st8 = game(8, { teamMode: true });
  assert.deepEqual(st8.players.map((p) => p.team), [0, 1, 0, 1, 0, 1, 0, 1]);
});

test('assist mode: finished player moves a teammate token', () => {
  const H = homeProgress(4);
  let st = game(4, { teamMode: true, assist: true });
  setTokens(st, 0, [H, H, H, H]);
  st.players[0].done = true;
  setTokens(st, 2, [10, -1, -1, -1]);
  const r = roll(st, 3);
  assert.equal(r.state.phase, 'move');
  assert.deepEqual(r.state.legal.map((m) => m.seat), [2]);
  const r2 = move(r.state, { seat: 2, token: 0 });
  assert.equal(r2.state.players[2].tokens[0], 13);
});

test('illegal moves are rejected', () => {
  const st = roll(game(), 6).state;
  assert.throws(() => move(st, { seat: 1, token: 0 }));
  assert.throws(() => roll(st, 3), /roll phase/);
  assert.throws(() => roll(game(), 7));
});

test('replaying broadcast events rebuilds an identical state', () => {
  let st = game();
  const log = [];
  let s = st;
  const seq = [6, 4, 3, 6, 6, 2, 5, 1, 6, 3];
  for (const v of seq) {
    const r = roll(s, v);
    log.push(...r.events);
    s = r.state;
    if (s.phase === 'move') {
      const m = s.legal[0];
      const r2 = move(s, m);
      log.push(...r2.events);
      s = r2.state;
    }
  }
  assert.deepEqual(applyEvents(st, log), s);
});

test('random full games always terminate with complete ranks', () => {
  for (const n of [4, 6, 8]) {
    for (const teamMode of [false, true]) {
      let st = game(n, { teamMode, blockades: n === 6 });
      let guard = 0;
      while (!st.over && guard++ < 50000) {
        st = roll(st, 1 + Math.floor(Math.random() * 6)).state;
        if (st.phase === 'move') st = move(st, st.legal[Math.floor(Math.random() * st.legal.length)]).state;
      }
      assert.ok(st.over, `n=${n} team=${teamMode} finished`);
      assert.equal(st.ranks.length, teamMode ? 2 : n);
    }
  }
});
