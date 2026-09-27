/**
 * Joseki geometry (SEN-114): every preset has a drawing, stones sit on board
 * intersections inside the box, and the fit is uniform and centred.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listPresets } from '@sente/presets';

import { JOSEKI_COLS, JOSEKI_ROWS, josekiFor, josekiLayout } from './joseki.ts';

test('every catalog preset has a pattern on the 7 × 5 board', () => {
  for (const def of listPresets()) {
    const pattern = josekiFor(def.id);
    assert.ok(pattern.stones.length > 0, def.id);
    for (const [c, r] of pattern.stones) {
      assert.ok(c >= 0 && c < JOSEKI_COLS && r >= 0 && r < JOSEKI_ROWS, `${def.id} ${c},${r}`);
    }
    for (const band of pattern.bands) assert.ok(band >= 0 && band < JOSEKI_ROWS);
  }
});

test('an unknown preset gets an empty board, not a crash', () => {
  const layout = josekiLayout(josekiFor('someday-preset'), { width: 60, height: 60 });
  assert.equal(layout.stones.length, 0);
  assert.equal(layout.grid.length, JOSEKI_COLS + JOSEKI_ROWS);
});

test('stones stay inside the box, small and large', () => {
  for (const [box, large] of [
    [{ width: 60, height: 60 }, false],
    [{ width: 124, height: 118 }, true],
  ] as const) {
    for (const def of listPresets()) {
      for (const s of josekiLayout(josekiFor(def.id), box, large).stones) {
        assert.ok(s.cx - s.r >= 0 && s.cx + s.r <= box.width, `${def.id} x`);
        assert.ok(s.cy - s.r >= 0 && s.cy + s.r <= box.height, `${def.id} y`);
      }
    }
  }
});

test('the fit is centred: a wide viewBox in a square box leaves equal margins', () => {
  const { grid } = josekiLayout(josekiFor('guardian'), { width: 60, height: 60 });
  const ys = grid.flatMap((s) => [s.y1, s.y2]);
  const top = Math.min(...ys);
  const bottom = 60 - Math.max(...ys);
  assert.ok(Math.abs(top - bottom) < 1e-9);
  assert.ok(top > 9 * (60 / 100)); // the study's pad plus the letterbox
});

test('watched levels are rings a little smaller than stones', () => {
  const { stones } = josekiLayout(josekiFor('guardian'), { width: 60, height: 60 });
  const stone = stones.find((s) => s.kind === 'agent');
  const ring = stones.find((s) => s.kind === 'watched');
  assert.ok(stone && ring);
  assert.ok(Math.abs(ring.r - stone.r * 0.82) < 1e-9);
});
