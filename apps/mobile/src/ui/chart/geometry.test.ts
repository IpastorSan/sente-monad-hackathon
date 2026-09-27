/** Chart geometry (SEN-107). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  areaPath,
  candleRects,
  formatPrice,
  lastTagWidth,
  levelLayout,
  linePath,
  markerIndex,
  nearestIndex,
  priceDecimals,
  scaleFor,
  xOf,
  yOf,
  EDGE_STEP,
} from './geometry.ts';

const BOX = { height: 200, padTop: 14, padBottom: 14 };

test('scaleFor pads the price span by 6 % each side', () => {
  const s = scaleFor([10, 20], [], BOX);
  assert.ok(Math.abs(s.lo - 9.4) < 1e-9);
  assert.ok(Math.abs(s.hi - 20.6) < 1e-9);
  assert.equal(s.top, 14);
  assert.equal(s.bottom, 186);
  // The data never touches the plot's edges.
  assert.ok(yOf(s, 20) > s.top && yOf(s, 10) < s.bottom);
});

test('scaleFor gives a flat series a span instead of dividing by zero', () => {
  const s = scaleFor([5, 5, 5], [], BOX);
  assert.ok(s.hi > 5 && s.lo < 5);
  assert.ok(Number.isFinite(yOf(s, 5)));
  const zero = scaleFor([0, 0], [], BOX);
  assert.ok(zero.hi > zero.lo);
});

test('yOf maps hi to the top and lo to the bottom', () => {
  const s = scaleFor([0, 100], [], BOX);
  assert.equal(yOf(s, s.hi), 14);
  assert.equal(yOf(s, s.lo), 186);
});

test('fit pulls levels into the scale; fit:false leaves them out as edge chips', () => {
  const closes = [0.98, 1.0, 0.99];
  const liq = 1.48;
  const stop = 0.9;

  const fitted = scaleFor(closes, [liq, stop], BOX);
  assert.ok(fitted.hi > liq && fitted.lo < stop);
  const onScale = levelLayout([liq, stop], fitted, BOX.height);
  assert.deepEqual(
    onScale.map((l) => [l.onScale, l.edge]),
    [
      [true, null],
      [true, null],
    ],
  );

  const priceOnly = scaleFor(closes, [liq, stop], { ...BOX, fit: false });
  assert.ok(priceOnly.hi < liq);
  const chips = levelLayout([liq, stop, 0.99], priceOnly, BOX.height);
  assert.deepEqual(chips[0], { y: 12, onScale: false, edge: 'top' });
  assert.deepEqual(chips[1], { y: 196, onScale: false, edge: 'bottom' });
  assert.equal(chips[2]?.onScale, true);
  assert.equal(chips[2]?.edge, null);
});

test('chips on the same edge stack instead of overprinting', () => {
  const s = scaleFor([1, 2], [], { ...BOX, fit: false });
  const chips = levelLayout([5, 6, -3, -4], s, BOX.height);
  assert.deepEqual(
    chips.map((c) => c.y),
    [12, 12 + EDGE_STEP, 196, 196 - EDGE_STEP],
  );
});

test('candleRects: body spans open..close, wick spans high..low, colour by direction', () => {
  const s = scaleFor([90, 110], [], BOX);
  const [up, down, doji] = candleRects(
    [
      { open: '95', high: '110', low: '90', close: '105' },
      { open: '105', high: '108', low: '96', close: '100' },
      { open: '100', high: '101', low: '99', close: '100' },
    ],
    s,
    300,
  );
  assert.ok(up && down && doji);

  assert.equal(up.up, true);
  assert.equal(up.body.y, yOf(s, 105));
  assert.ok(Math.abs(up.body.height - (yOf(s, 95) - yOf(s, 105))) < 1e-9);
  assert.equal(up.wick.top, yOf(s, 110));
  assert.equal(up.wick.bottom, yOf(s, 90));
  assert.equal(up.x, 0);

  assert.equal(down.up, false);
  assert.equal(down.body.y, yOf(s, 105));
  assert.equal(down.x, 150);

  // A doji still draws: 1 px tall, and open == close counts as up.
  assert.equal(doji.up, true);
  assert.equal(doji.body.height, 1);
  assert.equal(doji.x, 300);

  // 62 % of a 100 px slot, centred on the sample.
  assert.ok(Math.abs(up.body.width - 62) < 1e-9);
  assert.ok(Math.abs(down.body.x - (150 - 31)) < 1e-9);
});

test('candle bodies never go thinner than 2 px', () => {
  const s = scaleFor([1, 2], [], BOX);
  const many = Array.from({ length: 500 }, () => ({ open: '1', high: '2', low: '1', close: '2' }));
  for (const c of candleRects(many, s, 100)) assert.equal(c.body.width, 2);
});

test('nearestIndex rounds to the closest sample and clamps at both edges', () => {
  assert.equal(nearestIndex(0, 5, 100), 0);
  assert.equal(nearestIndex(12, 5, 100), 0);
  assert.equal(nearestIndex(13, 5, 100), 1);
  assert.equal(nearestIndex(100, 5, 100), 4);
  assert.equal(nearestIndex(-40, 5, 100), 0);
  assert.equal(nearestIndex(180, 5, 100), 4);
  assert.equal(nearestIndex(50, 1, 100), 0);
  assert.equal(nearestIndex(50, 5, 0), 0);
});

test('xOf puts the first sample on the left and the last on the right', () => {
  assert.equal(xOf(0, 3, 200), 0);
  assert.equal(xOf(2, 3, 200), 200);
  assert.equal(xOf(0, 1, 200), 200);
});

test('linePath and areaPath', () => {
  const s = scaleFor([0, 10], [], { height: 100, padTop: 0, padBottom: 0 });
  const line = linePath([0, 10], s, 100);
  assert.match(line, /^M0,\d+(\.\d)?L100,\d+(\.\d)?$/);
  assert.equal(areaPath([0, 10], s, 100, 100), `${line}L100,100L0,100Z`);
  assert.equal(areaPath([], s, 100, 100), '');
});

test('lastTagWidth grows with the label and never drops under 58', () => {
  assert.equal(lastTagWidth('0.97'), 58);
  assert.ok(Math.abs(lastTagWidth('12,345.00') - (9 * 6.4 + 22)) < 1e-9);
});

test('formatPrice rounds on the digits and groups thousands', () => {
  assert.equal(formatPrice('2498', 2), '2,498.00');
  assert.equal(formatPrice('0.97444', 4), '0.9744');
  assert.equal(formatPrice('0.97445', 4), '0.9745');
  assert.equal(formatPrice('0.99995', 4), '1.0000');
  assert.equal(formatPrice('1999.995', 2), '2,000.00');
  assert.equal(formatPrice('1.5', 0), '2');
  assert.equal(formatPrice('-0.00001', 2), '0.00');
  assert.equal(formatPrice('-3.2', 2), '−3.20');
  assert.equal(formatPrice('abc', 2), null);
  assert.equal(priceDecimals(0.97), 4);
  assert.equal(priceDecimals(2498), 2);
});

test('markerIndex counts negatives from the end and clamps', () => {
  assert.equal(markerIndex(-1, 10), 9);
  assert.equal(markerIndex(3, 10), 3);
  assert.equal(markerIndex(40, 10), 9);
  assert.equal(markerIndex(-40, 10), 0);
});
