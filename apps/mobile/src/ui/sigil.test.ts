/** Agent sigils. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIGIL_LINES, sigilStones } from './sigil.ts';

test('the same seed always places the same stones', () => {
  assert.deepEqual(sigilStones('agent-7f3c'), sigilStones('agent-7f3c'));
});

test('different seeds place different stones', () => {
  const a = JSON.stringify(sigilStones('range-hunter'));
  const b = JSON.stringify(sigilStones('basis-monk'));
  assert.notEqual(a, b);
});

test('three or four stones, on distinct intersections inside the board', () => {
  for (const seed of ['a', 'b', 'range-hunter', '0x7a3f', '']) {
    const stones = sigilStones(seed);
    assert.ok(stones.length === 3 || stones.length === 4, `${seed}: ${stones.length}`);
    const cells = new Set(stones.map((s) => `${s.x},${s.y}`));
    assert.equal(cells.size, stones.length);
    for (const s of stones) {
      assert.ok(s.x >= 0 && s.x < SIGIL_LINES && s.y >= 0 && s.y < SIGIL_LINES);
    }
  }
});

test('tones alternate, purple first', () => {
  const tones = sigilStones('tengen').map((s) => s.tone);
  tones.forEach((tone, i) => assert.equal(tone, i % 2 === 0 ? 'purple' : 'white'));
});
