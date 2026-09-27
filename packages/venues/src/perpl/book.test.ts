import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyL2BookUpdate } from './book.ts';
import type { PerplL2Book } from './wire.ts';

const snapshot: PerplL2Book = {
  mt: 15,
  sid: 1000016,
  sn: 10,
  at: { b: 10, t: 1000 },
  bid: [
    { p: 100, s: 5, o: 1 },
    { p: 99, s: 4, o: 1 },
  ],
  ask: [
    { p: 101, s: 3, o: 1 },
    { p: 102, s: 2, o: 1 },
  ],
};

test('applyL2BookUpdate: replaces by price, removes o:0, keeps best-first order', () => {
  // Shaped like a live testnet mt:16 (SEN-62): only changed levels, s:0/o:0 to remove.
  const next = applyL2BookUpdate(snapshot, {
    mt: 16,
    sid: 1000016,
    sn: 12,
    at: { b: 12, t: 1002 },
    bid: [
      { p: 101, s: 9, o: 2 },
      { p: 100, s: 0, o: 0 },
    ],
    ask: [
      { p: 101, s: 0, o: 0 },
      { p: 103, s: 1, o: 1 },
      { p: 102, s: 6, o: 3 },
    ],
  });
  assert.deepEqual(next.bid, [
    { p: 101, s: 9, o: 2 },
    { p: 99, s: 4, o: 1 },
  ]);
  assert.deepEqual(next.ask, [
    { p: 102, s: 6, o: 3 },
    { p: 103, s: 1, o: 1 },
  ]);
  assert.deepEqual(next.at, { b: 12, t: 1002 });
  assert.equal(next.sn, 12);
  assert.equal(next.mt, 15);
  assert.equal(snapshot.bid.length, 2, 'the input is not mutated');
});

test('applyL2BookUpdate: a one-sided update leaves the other side as it was', () => {
  const next = applyL2BookUpdate(snapshot, {
    mt: 16,
    sid: 1000016,
    at: { b: 11 },
    bid: [],
    ask: [{ p: 102, s: 0, o: 0 }],
  });
  assert.deepEqual(next.bid, snapshot.bid);
  assert.deepEqual(next.ask, [{ p: 101, s: 3, o: 1 }]);
  assert.equal(next.sn, 10);
});
