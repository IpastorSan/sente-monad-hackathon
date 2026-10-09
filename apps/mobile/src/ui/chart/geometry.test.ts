/** Chart geometry (SEN-107). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

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
  pointsXY,
  scaleFor,
  sparklineModel,
  toPrice,
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

// ── Hardening (SEN-141) ─────────────────────────────────────────────────────

test('toPrice: a blank or non-finite wire price is NaN, never 0', () => {
  // `Number('')` is 0: a blank close used to draw as a crash to zero.
  for (const bad of ['', '   ', 'abc', 'NaN', 'Infinity', '-Infinity', '1e999']) {
    assert.ok(Number.isNaN(toPrice(bad)), JSON.stringify(bad));
  }
  assert.equal(toPrice('0'), 0);
  assert.equal(toPrice(' 0.9744 '), 0.9744);
});

test('linePath drops a sample that is not a price instead of emitting NaN', () => {
  const s = scaleFor([0, 10], [], { height: 100, padTop: 0, padBottom: 0 });
  const clean = linePath([1, 2], s, 100);
  // The audit's case: `linePath([1, NaN, 2])` emitted `L50,NaN`, and Skia
  // draws nothing for a path with a NaN in it.
  const holed = linePath([1, Number.NaN, 2], s, 100);
  assert.doesNotMatch(holed, /NaN|Infinity/);
  assert.equal(holed, clean);
  assert.doesNotMatch(linePath([1, Infinity, -Infinity, 2], s, 100), /NaN|Infinity/);
  // A leading bad sample: the path still opens with `M`, at the first good one.
  assert.match(linePath([Number.NaN, 1, 2], s, 100), /^M50,[\d.]+L100,[\d.]+$/);
  assert.equal(linePath([Number.NaN, Number.NaN], s, 100), '');
});

test('areaPath closes under the samples the line actually draws', () => {
  const s = scaleFor([0, 10], [], { height: 100, padTop: 0, padBottom: 0 });
  const area = areaPath([Number.NaN, 5, 6, Number.NaN, Number.NaN], s, 100, 100);
  assert.doesNotMatch(area, /NaN|Infinity/);
  assert.match(area, /L50,100L25,100Z$/);
  assert.equal(areaPath([Number.NaN], s, 100, 100), '');
});

test('pointsXY holds the last good y for a bad sample, so the scrub dot is never NaN', () => {
  const s = scaleFor([0, 10], [], BOX);
  const xy = pointsXY([Number.NaN, 2, Number.NaN, 8, Infinity], s, 100);
  assert.deepEqual(
    xy.map((p) => p.y),
    [yOf(s, 2), yOf(s, 2), yOf(s, 2), yOf(s, 8), yOf(s, 8)],
  );
  const none = pointsXY([Number.NaN], s, 100);
  assert.equal(none[0]?.y, (s.top + s.bottom) / 2);
});

test('candleRects skips a kline with a price that is not one', () => {
  const s = scaleFor([90, 110], [], BOX);
  const rects = candleRects(
    [
      { open: '95', high: '110', low: '90', close: '105' },
      { open: '100', high: '', low: '96', close: '100' },
      { open: '100', high: '108', low: '96', close: 'Infinity' },
      { open: '100', high: '108', low: '96', close: '101' },
    ],
    s,
    300,
  );
  assert.deepEqual(
    rects.map((r) => r.x),
    [0, 300],
    'the good candles keep their own slots',
  );
});

test('markerIndex has nothing to point at in an empty series', () => {
  // Clamping into `[0, -1]` gave 0: a sample that does not exist.
  assert.equal(markerIndex(0, 0), null);
  assert.equal(markerIndex(-1, 0), null);
  assert.equal(markerIndex(Number.NaN, 5), null);
  assert.equal(markerIndex(1.7, 5), 1);
  assert.equal(markerIndex(-1.2, 5), 4);
});

// ── Invariants (SEN-141) ────────────────────────────────────────────────────

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 400, seed: 141 };

/** A wire price as the API might send it, garbage included. */
const wirePrice = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: -1e9, max: 1e9, noNaN: true }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 100_000 }).map(String) },
  { weight: 1, arbitrary: fc.constantFrom('', ' ', 'NaN', 'Infinity', '-Infinity', 'abc') },
);
const box = fc.record({
  width: fc.integer({ min: 1, max: 1000 }),
  height: fc.integer({ min: 40, max: 600 }),
  padTop: fc.integer({ min: 0, max: 16 }),
  padBottom: fc.integer({ min: 0, max: 16 }),
});

/** Every `x,y` pair in an `M…L…Z` path. */
function coords(path: string): [number, number][] {
  return [...path.matchAll(/[ML]([^,MLZ]+),([^MLZ]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

test('property: every drawn point lies inside the plot box, and no path has a NaN', () => {
  fc.assert(
    fc.property(fc.array(wirePrice, { maxLength: 60 }), box, (wire, b) => {
      const closes = wire.map(toPrice);
      const scale = scaleFor(closes, [], b);
      // Rounded to 0.1 px in the path, so half of that is slack.
      const inside = ([x, y]: [number, number]) =>
        x >= -0.05 && x <= b.width + 0.05 && y >= scale.top - 0.05 && y <= scale.bottom + 0.05;

      const line = linePath(closes, scale, b.width);
      assert.doesNotMatch(line, /NaN|Infinity/);
      for (const c of coords(line)) assert.ok(inside(c), `${c} outside in ${line}`);

      const area = areaPath(closes, scale, b.width, b.height);
      assert.doesNotMatch(area, /NaN|Infinity/);

      for (const p of pointsXY(closes, scale, b.width)) assert.ok(inside([p.x, p.y]));
    }),
    RUNS,
  );
});

test('property: yOf is monotone — a higher price is never drawn lower', () => {
  fc.assert(
    fc.property(
      fc.array(fc.double({ min: -1e9, max: 1e9, noNaN: true }), { minLength: 2, maxLength: 20 }),
      box,
      (prices, b) => {
        const scale = scaleFor(prices, [], b);
        const sorted = [...prices].sort((p, q) => p - q);
        const ys = sorted.map((p) => yOf(scale, p));
        for (let i = 1; i < ys.length; i++) assert.ok((ys[i] as number) <= (ys[i - 1] as number));
      },
    ),
    RUNS,
  );
});

test('property: candle rects are finite and inside the plot box', () => {
  const kline = fc.record({ open: wirePrice, high: wirePrice, low: wirePrice, close: wirePrice });
  fc.assert(
    fc.property(fc.array(kline, { maxLength: 40 }), box, (klines, b) => {
      const scale = scaleFor(
        klines.flatMap((k) => [toPrice(k.high), toPrice(k.low), toPrice(k.open), toPrice(k.close)]),
        [],
        b,
      );
      for (const r of candleRects(klines, scale, b.width)) {
        const ys = [r.wick.top, r.wick.bottom, r.body.y, r.body.y + r.body.height];
        for (const y of ys)
          assert.ok(Number.isFinite(y) && y >= scale.top - 1 && y <= scale.bottom + 1);
        assert.ok(Number.isFinite(r.x) && r.x >= 0 && r.x <= b.width);
      }
    }),
    RUNS,
  );
});

test('property: markerIndex lands on a real sample or on nothing', () => {
  fc.assert(
    fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 50 }), (i, n) => {
      const at = markerIndex(i, n);
      if (n === 0) assert.equal(at, null);
      else assert.ok(at !== null && Number.isInteger(at) && at >= 0 && at < n);
    }),
    RUNS,
  );
});

test('sparklineModel: nothing for an empty series', () => {
  assert.equal(sparklineModel([], 64, 28), null);
});

test('sparklineModel: the line ends on the dot, inside the box, short of the right pad', () => {
  const model = sparklineModel(['1', '3', '2'], 64, 28);
  assert.ok(model !== null);
  assert.equal(model.rising, true);
  assert.match(model.path, /^M0,[\d.]+L30,[\d.]+L60,[\d.]+$/);
  assert.equal(model.end.x, 60);
  assert.ok(model.path.endsWith(`L60,${Math.round(model.end.y * 10) / 10}`));
  assert.ok(model.end.y >= 3 && model.end.y <= 25);
});

test('sparklineModel: a falling series is not rising', () => {
  assert.equal(sparklineModel(['5', '4'], 64, 28)?.rising, false);
});
