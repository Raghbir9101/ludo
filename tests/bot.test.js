import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, roll, move } from '../shared/engine.js';
import { chooseMove } from '../shared/botcore.js';
import { startSquare, trackLen, homeProgress } from '../shared/rules.js';

test('hard bot prefers a capture', () => {
  const st = createGame({ n: 4 });
  const target = (startSquare(0) + 12) % trackLen(4);
  st.players[0].tokens = [9, 20, -1, -1];
  st.players[1].tokens = [(target - startSquare(1) + trackLen(4)) % trackLen(4), -1, -1, -1];
  const r = roll(st, 3).state;
  assert.deepEqual(chooseMove(r, 'hard'), r.legal.find((m) => m.token === 0));
});

test('hard bot takes a token home when it can', () => {
  const st = createGame({ n: 4 });
  const H = homeProgress(4);
  st.players[0].tokens = [H - 4, 5, -1, -1];
  const r = roll(st, 4).state;
  assert.equal(chooseMove(r, 'hard').token, 0);
});

test('bots form a pair to protect a threatened token', () => {
  const st = createGame({ n: 4 });
  const abs = (p) => (startSquare(0) + p) % trackLen(4);
  st.players[0].tokens = [14, 17, -1, -1];
  st.players[2].tokens = [(abs(12) - startSquare(2) + trackLen(4)) % trackLen(4), -1, -1, -1];
  const r = roll(st, 3).state;
  for (const d of ['medium', 'hard']) assert.equal(chooseMove(r, d, () => 0.5).token, 0, d);
});

test('bots of every difficulty finish full games', () => {
  for (const diff of ['easy', 'medium', 'hard']) {
    let st = createGame({ n: 6 });
    let guard = 0;
    while (!st.over && guard++ < 40000) {
      st = roll(st, 1 + Math.floor(Math.random() * 6)).state;
      if (st.phase === 'move') st = move(st, chooseMove(st, diff)).state;
    }
    assert.ok(st.over, diff);
  }
});

test('hard beats easy most of the time', () => {
  let hardWins = 0;
  const games = 40;
  for (let g = 0; g < games; g++) {
    let st = createGame({ n: 4, seats: [{}, { active: false }, {}, { active: false }], firstTurn: g % 2 ? 0 : 2 });
    while (!st.over) {
      st = roll(st, 1 + Math.floor(Math.random() * 6)).state;
      if (st.phase === 'move') st = move(st, chooseMove(st, st.turn === 0 ? 'hard' : 'easy')).state;
    }
    if (st.ranks[0] === 0) hardWins++;
  }
  assert.ok(hardWins > games * 0.55, `hard won ${hardWins}/${games}`);
});
