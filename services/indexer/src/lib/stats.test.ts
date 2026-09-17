import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFill, kuruQuoteAtoms, perplQuoteAtoms, yyyymmdd, type PositionState } from './stats.ts';

test('long opened at 10, closed at 12 realises +2', () => {
  const open = applyFill({ baseRaw: 0n, costRaw: 0n }, 1n, 10n);
  assert.equal(open.baseRaw, 1n);
  assert.equal(open.costRaw, 10n);
  assert.equal(open.realizedRaw, 0n);
  const close = applyFill(open, -1n, 12n);
  assert.equal(close.baseRaw, 0n);
  assert.equal(close.costRaw, 0n);
  assert.equal(close.realizedRaw, 2n);
  assert.equal(close.reduces, true);
});

test('short opened at 10, covered at 8 realises +2', () => {
  const open = applyFill({ baseRaw: 0n, costRaw: 0n }, -1n, 10n);
  assert.equal(open.baseRaw, -1n);
  assert.equal(open.costRaw, -10n);
  const cover = applyFill(open, 1n, 8n);
  assert.equal(cover.baseRaw, 0n);
  assert.equal(cover.costRaw, 0n);
  assert.equal(cover.realizedRaw, 2n);
});

test('adding to a position realises nothing and extends the average', () => {
  let pos = applyFill({ baseRaw: 0n, costRaw: 0n }, 1n, 10n); // 1 @ 10
  pos = applyFill(pos, 1n, 20n); // +1 @ 20 → average 15
  assert.equal(pos.baseRaw, 2n);
  assert.equal(pos.costRaw, 30n);
  assert.equal(pos.realizedRaw, 0n);
  const close = applyFill(pos, -2n, 30n); // −2 @ 15 (30 atoms total)
  assert.equal(close.realizedRaw, 0n);
  assert.equal(close.baseRaw, 0n);
});

test('partial reduce keeps proportional basis', () => {
  let pos = applyFill({ baseRaw: 0n, costRaw: 0n }, 4n, 40n); // 4 @ avg 10
  pos = applyFill(pos, -1n, 12n); // sell 1 @ 12
  assert.equal(pos.baseRaw, 3n);
  assert.equal(pos.realizedRaw, 2n);
  assert.equal(pos.costRaw, 30n); // 3 × avg 10
});

test('flip closes old basis and reopens at trade price', () => {
  let pos = applyFill({ baseRaw: 0n, costRaw: 0n }, 1n, 10n); // long 1 @ 10
  pos = applyFill(pos, -3n, 36n); // sell 3 @ 12: close 1 (+2), short 2 @ 12
  assert.equal(pos.baseRaw, -2n);
  assert.equal(pos.costRaw, -24n);
  assert.equal(pos.realizedRaw, 2n);
});

test('losing trades realise negative', () => {
  let pos = applyFill({ baseRaw: 0n, costRaw: 0n }, 2n, 20n); // long 2 @ 10
  pos = applyFill(pos, -2n, 16n); // sell 2 @ 8
  assert.equal(pos.realizedRaw, -4n);
  assert.equal(pos.baseRaw, 0n);
  const short = applyFill({ baseRaw: 0n, costRaw: 0n }, -1n, 10n); // short 1 @ 10
  const loss = applyFill(short, 1n, 13n); // cover @ 13
  assert.equal(loss.realizedRaw, -3n);
});

test('zero-size trade is inert', () => {
  const pos = applyFill({ baseRaw: 5n, costRaw: 50n }, 0n, 99n);
  assert.deepEqual(pos, { baseRaw: 5n, costRaw: 50n, realizedRaw: 0n, reduces: false });
});

test('closed positions have zero cost; floors only shave dust', () => {
  let pos: PositionState = { baseRaw: 0n, costRaw: 0n };
  let realized = 0n;
  let res = applyFill(pos, 7n, 71n); // avg 10.142…
  pos = res;
  res = applyFill(pos, -3n, 29n); // close 3 @ 9.666…
  realized += res.realizedRaw;
  pos = res;
  res = applyFill(pos, -4n, 44n); // close 4 @ 11
  realized += res.realizedRaw;
  assert.equal(res.baseRaw, 0n);
  assert.equal(res.costRaw, 0n);
  // exact total is (29+44) − 71 = 2; per-step truncation moves it by ≤1 dust
  // atom each way (atomsClosed floor ↓, basisClosed floor ↓ ⇒ realized ↑)
  assert.ok(realized >= 0n && realized <= 4n, `realized=${realized}`);
});

test('kuruQuoteAtoms floors like the contract', () => {
  // MON-USDC live fill (docs/kuru.md): price 30974 ×1e6, size 31773742494 ×1e8
  const atoms = kuruQuoteAtoms(30974n, 31773742494n, 1_000_000n, 100_000_000n, 6);
  assert.equal(atoms, 9_841_599n); // $9.841599
});

test('perplQuoteAtoms scales PNS/LNS to CNS', () => {
  // BTC (pd=1, sd=5): price 110000 PNS = $11000.0, size 100000 LNS = 1 BTC
  const cns = perplQuoteAtoms(110_000n, 100_000n, 1, 5, 6);
  assert.equal(cns, 11_000_000_000n); // 11000.000000 AUSD
});

test('yyyymmdd is UTC', () => {
  assert.equal(yyyymmdd(1789637386), 20260917);
  assert.equal(yyyymmdd(0), 19700101);
});
