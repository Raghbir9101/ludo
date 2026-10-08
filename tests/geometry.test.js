import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, cellPos, rotateBoard, povSteps } from '../shared/geometry.js';
import { startSquare, cellOf, homeProgress, colStart, lastTrack } from '../shared/rules.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

for (const n of [4, 6, 8]) {
  test(`board n=${n}: square counts`, () => {
    const b = buildBoard(n);
    assert.equal(b.track.length, 13 * n);
    assert.equal(b.homeCol.length, n);
    assert.ok(b.homeCol.every((c) => c.length === 5));
    assert.equal(b.yards.length, n);
    assert.ok(b.yards.every((y) => y.slots.length === 4));
    assert.equal(b.center.slots.length, n);
    assert.equal(b.center.tris.length, n);
  });

  test(`board n=${n}: consecutive track squares are adjacent`, () => {
    const b = buildBoard(n);
    const L = b.track.length;
    for (let i = 0; i < L; i++) {
      const d = dist(b.track[i], b.track[(i + 1) % L]);
      const corner = i % 13 === 12;
      if (corner) assert.ok(d > 0.99 && d < 2.0, `corner step ${i} = ${d}`);
      else assert.ok(Math.abs(d - 1) < 1e-9, `step ${i} = ${d}`);
    }
  });

  test(`board n=${n}: no two squares overlap`, () => {
    const b = buildBoard(n);
    const all = [...b.track, ...b.homeCol.flat()];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        assert.ok(dist(all[i], all[j]) > 0.99, `squares ${i} and ${j} overlap`);
      }
    }
  });

  test(`board n=${n}: home column starts next to the entry square and runs to the center`, () => {
    const b = buildBoard(n);
    for (let s = 0; s < n; s++) {
      const entry = cellPos(b, s, cellOf(n, s, lastTrack(n)));
      const first = cellPos(b, s, cellOf(n, s, colStart(n)));
      assert.ok(Math.abs(dist(entry, first) - 1) < 1e-9);
      const col = b.homeCol[s];
      for (let j = 1; j < col.length; j++) assert.ok(Math.abs(dist(col[j - 1], col[j]) - 1) < 1e-9);
      assert.ok(Math.hypot(col[4].x, col[4].y) < Math.hypot(col[0].x, col[0].y));
      const home = cellPos(b, s, cellOf(n, s, homeProgress(n)), 0);
      assert.ok(Math.hypot(home.x, home.y) < b.apothem);
    }
  });

  test(`board n=${n}: each start square sits beside its own yard`, () => {
    const b = buildBoard(n);
    for (let s = 0; s < n; s++) {
      const start = b.track[startSquare(s)];
      const own = dist(start, b.yards[s].center);
      for (let o = 0; o < n; o++) if (o !== s) assert.ok(own < dist(start, b.yards[o].center));
      assert.equal(start.start, s);
    }
    assert.equal(b.track.filter((t) => t.star).length, n);
  });

  test(`board n=${n}: yard slots fit inside the board outline`, () => {
    const b = buildBoard(n);
    const maxR = Math.hypot(b.outline[0].x, b.outline[0].y);
    for (const y of b.yards) for (const p of y.slots) assert.ok(Math.hypot(p.x, p.y) < maxR);
  });

  test(`board n=${n}: rotating puts any seat in the bottom-left yard and keeps the shape`, () => {
    const base = buildBoard(n);
    for (let s = 0; s < n; s++) {
      const b = rotateBoard(base, povSteps(n, s));
      const me = b.yards[s].center;
      assert.ok(me.x < 0 && me.y > 0, `seat ${s} at ${me.x}, ${me.y}`);
      const bottom = b.yards.filter((y) => y.center.y > 0.01);
      assert.ok(bottom.every((y) => y.center.x >= me.x - 1e-9), `seat ${s} is the leftmost bottom yard`);
      for (const k of ['minX', 'minY', 'maxX', 'maxY']) assert.ok(Math.abs(b.bounds[k] - base.bounds[k]) < 1e-9);
      for (let i = 0; i < b.track.length; i++) {
        assert.ok(Math.abs(dist(b.track[i], b.track[(i + 1) % b.track.length]) - dist(base.track[i], base.track[(i + 1) % base.track.length])) < 1e-9);
      }
      assert.ok(dist(b.track[startSquare(s)], me) < dist(b.track[startSquare(s)], b.yards[(s + 1) % n].center));
    }
    assert.equal(rotateBoard(base, 0), base);
    assert.equal(povSteps(n, null), 0);
  });
}
