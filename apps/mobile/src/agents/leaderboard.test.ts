/**
 * The leaderboard row text (SEN-26), under plain node.
 *
 * The load-bearing test here is the first one: the screen cannot print a win
 * rate without its `n`, because `rateWithSample` is the only function that
 * prints one at all. Everything else is formatting, pinned so a row reads the
 * same on every device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  amountLabel,
  percent,
  pnlLabel,
  rankLabel,
  rateWithSample,
  roiLabel,
  thesisLabel,
  tooFewLabel,
  venueLabel,
} from './leaderboard.ts';

test('a win rate is never printed without the sample it came from', () => {
  assert.equal(rateWithSample(0.625, 8), '62.5% · n 8');
  assert.equal(rateWithSample(1, 1204), '100% · n 1,204');
  for (const label of [rateWithSample(0.625, 8), rateWithSample(0.5, 3), rateWithSample(1, 2)]) {
    assert.match(label, /· n [\d,]+$/u);
  }
});

test('a rate that does not exist says so rather than reading as 0% or 100%', () => {
  assert.equal(rateWithSample(null, 0), 'no settled trades');
  assert.equal(rateWithSample(0, 0), 'no settled trades');
  assert.equal(rateWithSample(null, 4), 'no settled trades');
});

test('ROI carries its sign, and no ROI is a dash rather than a zero', () => {
  assert.equal(roiLabel(0.2), '+20%');
  assert.equal(roiLabel(0.0421), '+4.2%');
  assert.equal(roiLabel(-0.125), '−12.5%');
  assert.equal(roiLabel(0), '0%');
  assert.equal(roiLabel(null), '—');
});

test('money is grouped and rounded to the cent, and the sign is a real minus', () => {
  assert.equal(pnlLabel('25'), '+25.00');
  assert.equal(pnlLabel('-3.1'), '−3.10');
  assert.equal(pnlLabel('0'), '0.00');
  assert.equal(pnlLabel('1234.567'), '+1,234.57');
  assert.equal(pnlLabel('-1234.5'), '−1,234.50');
  // Unparseable input is handed back, never invented.
  assert.equal(pnlLabel('twelve'), 'twelve');
});

test('capital deployed has no sign', () => {
  assert.equal(amountLabel('100'), '100.00');
  assert.equal(amountLabel('0.5'), '0.50');
  assert.equal(amountLabel(''), '0.00');
});

test('a rank is a zero-padded column, and an unranked row has none', () => {
  assert.equal(rankLabel(1), '01');
  assert.equal(rankLabel(9), '09');
  assert.equal(rankLabel(10), '10');
  assert.equal(rankLabel(null), '—');
});

test('the theses reading carries its own denominator and is never a percentage', () => {
  assert.equal(thesisLabel({ settled: 3, held: 2, open: 0 }), '2 of 3 theses held');
  assert.equal(thesisLabel({ settled: 12, held: 7, open: 2 }), '7 of 12 theses held · 2 open');
  assert.equal(thesisLabel({ settled: 0, held: 0, open: 1 }), 'no settled theses · 1 open');
  assert.equal(thesisLabel({ settled: 0, held: 0, open: 0 }), 'no settled theses');
});

test('the venues are named, and an agent with none says it is not indexed', () => {
  assert.equal(venueLabel(['kuru']), 'Kuru');
  assert.equal(venueLabel(['kuru', 'perpl']), 'Kuru · Perpl');
  assert.equal(venueLabel([]), 'not indexed yet');
});

test('an unranked row says how short it is of the threshold', () => {
  assert.equal(tooFewLabel(0, 3), '3 more settled trades to be ranked');
  assert.equal(tooFewLabel(2, 3), '1 more settled trade to be ranked');
  assert.equal(tooFewLabel(3, 3), '0 more settled trades to be ranked');
});

test('percent keeps one decimal, and none when there is none', () => {
  assert.equal(percent(0.625), '62.5%');
  assert.equal(percent(0.5), '50%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(0.0313), '3.1%');
});
