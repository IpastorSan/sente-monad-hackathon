/**
 * The Top segment's pinned "your best" row (SEN-114).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ordinal, yourBest } from './top.ts';

const ranked = [
  { agentId: 'a', rank: 1 },
  { agentId: 'b', rank: 2 },
  { agentId: 'c', rank: 3 },
  { agentId: 'd', rank: 4 },
];

test('the best ranked row the user owns, with its standing', () => {
  const best = yourBest(ranked, new Set(['d', 'b']));
  assert.equal(best?.row.agentId, 'b');
  assert.equal(best?.label, 'Your best · 2nd of 4 ranked');
});

test('nothing owned, or only unranked rows owned: no pin', () => {
  assert.equal(yourBest(ranked, new Set()), null);
  assert.equal(yourBest([{ agentId: 'x', rank: null }], new Set(['x'])), null);
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), [
    '1st',
    '2nd',
    '3rd',
    '4th',
    '11th',
    '12th',
    '13th',
    '21st',
    '22nd',
    '23rd',
    '101st',
    '111th',
  ]);
});
