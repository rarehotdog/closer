import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTileFinds, overlapOfSmaller, tileRects, toFullFrame } from './tiles';

test('TL-01 tiles cover the whole photo, overlap their neighbours and stay inside it', () => {
  const t = tileRects(1600, 900, 2, 1);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].x1, t[0].y1, t[1].x2, t[1].y2], [0, 0, 1599, 899]);
  assert.ok(t[0].x2 > t[1].x1, 'tiles overlap');
  for (const r of tileRects(1201, 799, 3, 2)) {
    assert.ok(r.x1 >= 0 && r.y1 >= 0 && r.x2 <= 1200 && r.y2 <= 798 && r.x1 < r.x2 && r.y1 < r.y2);
  }
});

test('TL-02 a box found in a tile maps back to the full photo', () => {
  assert.deepEqual(toFullFrame({ x1: 10, y1: 20, x2: 110, y2: 220 }, { x1: 700, y1: 0, x2: 1599, y2: 899 }), { x1: 710, y1: 20, x2: 810, y2: 220 });
});

test('TL-03 the same garment seen in two tiles is kept once, as the larger box; separate garments all stay', () => {
  const whole = { id: 'a', box: { x1: 700, y1: 50, x2: 900, y2: 700 } };
  const cut = { id: 'b', box: { x1: 760, y1: 50, x2: 900, y2: 700 } }; // same coat, cut by a tile edge
  const other = { id: 'c', box: { x1: 1000, y1: 50, x2: 1180, y2: 600 } };
  const kept = mergeTileFinds([cut, other, whole]);
  assert.deepEqual(kept.map((k) => k.id).sort(), ['a', 'c']);
  assert.equal(overlapOfSmaller(whole.box, other.box), 0);
});
