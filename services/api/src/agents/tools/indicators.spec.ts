import {
  computeIndicator,
  countGaps,
  ema,
  formatValue,
  minCandles,
  rsi,
  sma,
  summarize,
  type Candle,
  type IndicatorSpec,
} from './indicators';
import { decimalsOf } from './decimal';

const HOUR = 3_600_000;

/** Candles from [high, low, close, volume?] rows, one hour apart. */
function candles(rows: readonly (readonly number[])[]): Candle[] {
  return rows.map(([high, low, close, volume = 1], i) => ({
    t: i * HOUR,
    open: close!,
    high: high!,
    low: low!,
    close: close!,
    volume,
  }));
}

/** Closes only: high = low = close. */
const fromCloses = (closes: readonly number[], volume = 1) =>
  candles(closes.map((c) => [c, c, c, volume]));

const out = (spec: IndicatorSpec, data: readonly Candle[], name = 'value') =>
  computeIndicator(spec, data).outputs[name]!.values;

const round = (values: readonly number[], places: number) =>
  values.map((v) => (Number.isFinite(v) ? Number(v.toFixed(places)) : null));

describe('published reference values', () => {
  // StockCharts ChartSchool, "Moving Averages - Simple and Exponential", the
  // worked example spreadsheet (cs-movavg.xls): 30 closes, 10-day SMA and EMA.
  const closes = [
    22.2734, 22.194, 22.0847, 22.1741, 22.184, 22.1344, 22.2337, 22.4323, 22.2436, 22.2933, 22.1542,
    22.3926, 22.3816, 22.6109, 23.3558, 24.0519, 23.753, 23.8324, 23.9516, 23.6338, 23.8225,
    23.8722, 23.6537, 23.187, 23.0976, 23.326, 22.6805, 23.0976, 22.4025, 22.1725,
  ];
  const warmup = new Array<null>(9).fill(null);

  it('10-day SMA matches StockCharts', () => {
    expect(round(sma(closes, 10), 2)).toEqual([
      ...warmup,
      22.22,
      22.21,
      22.23,
      22.26,
      22.31,
      22.42,
      22.61,
      22.77,
      22.91,
      23.08,
      23.21,
      23.38,
      23.53,
      23.65,
      23.71,
      23.69,
      23.61,
      23.51,
      23.43,
      23.28,
      23.13,
    ]);
  });

  it('10-day EMA (seeded with the SMA) matches StockCharts', () => {
    expect(round(ema(closes, 10), 2)).toEqual([
      ...warmup,
      22.22,
      22.21,
      22.24,
      22.27,
      22.33,
      22.52,
      22.8,
      22.97,
      23.13,
      23.28,
      23.34,
      23.43,
      23.51,
      23.54,
      23.47,
      23.4,
      23.39,
      23.26,
      23.23,
      23.08,
      22.92,
    ]);
  });

  it("14-day RSI (Wilder's smoothing) matches StockCharts", () => {
    // StockCharts ChartSchool, "Relative Strength Index (RSI)", worked example
    // spreadsheet (cs-rsi.xls): 33 closes, the first RSI on the 15th.
    const rsiCloses = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.2778, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
      45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439,
      46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672,
      43.4205, 42.6628, 43.1314,
    ];
    expect(round(rsi(rsiCloses, 14), 2)).toEqual([
      ...new Array<null>(14).fill(null),
      70.53,
      66.32,
      66.55,
      69.41,
      66.36,
      57.97,
      62.93,
      63.26,
      56.06,
      62.38,
      54.71,
      50.42,
      39.99,
      41.46,
      41.87,
      45.46,
      37.3,
      33.08,
      37.77,
    ]);
  });
});

describe('hand-checked small series', () => {
  it('wma(3) weights the newest close most', () => {
    // (1x1 + 2x2 + 3x3) / 6 = 14/6; (2 + 6 + 12) / 6 = 20/6.
    expect(round(out({ type: 'wma', period: 3 }, fromCloses([1, 2, 3, 4])), 6)).toEqual([
      null,
      null,
      2.333333,
      3.333333,
    ]);
  });

  it('macd(2,3,2) on 1, 2, 4, 8, 16', () => {
    // EMA2 (k 2/3): 1.5, 3.1667, 6.3889, 12.7963. EMA3 (k 1/2): 2.3333, 5.1667, 10.5833.
    // line: 0.8333, 1.2222, 2.2130. signal (EMA2 of line): 1.0278, then
    // 1.0278 + 2/3 (2.2130 - 1.0278) = 1.8179. histogram: 0.1944, 0.3951.
    // The line's first value (0.8333) waits for the signal's warm-up.
    const data = fromCloses([1, 2, 4, 8, 16]);
    const spec: IndicatorSpec = { type: 'macd', fast: 2, slow: 3, signal: 2 };
    expect(round(out(spec, data, 'line'), 4)).toEqual([null, null, null, 1.2222, 2.213]);
    expect(round(out(spec, data, 'signal'), 4)).toEqual([null, null, null, 1.0278, 1.8179]);
    expect(round(out(spec, data, 'histogram'), 4)).toEqual([null, null, null, 0.1944, 0.3951]);
    expect(minCandles(spec)).toBe(4);
  });

  it('atr(3): true range reaches back to the previous close across a gap', () => {
    const data = candles([
      [10, 8, 9],
      [11, 9, 10], // TR max(2, 2, 0) = 2
      [12, 10, 11], // TR 2
      [11, 7, 8], // TR max(4, 0, 4) = 4 → ATR (2 + 2 + 4) / 3 = 2.6667
      [9, 8, 8.5], // TR 1 → (2.6667 x 2 + 1) / 3 = 2.1111
      [14, 9, 13], // TR |14 - 8.5| = 5.5 → (2.1111 x 2 + 5.5) / 3 = 3.2407
    ]);
    expect(round(out({ type: 'atr', period: 3 }, data), 4)).toEqual([
      null,
      null,
      null,
      2.6667,
      2.1111,
      3.2407,
    ]);
  });

  it('adx(2): directional movement, Wilder-smoothed, then DX averaged', () => {
    const data = candles([
      [10, 9, 9.5],
      [11, 9.5, 10.5], // +DM 1, -DM 0, TR 1.5
      [12, 10, 11.5], // +DM 1, -DM 0, TR 2 → TR 1.75, +DM 1, -DM 0: +DI 57.14, DX 100
      [11.5, 9, 9.5], // +DM 0, -DM 1, TR 2.5 → TR 2.125, +DM 0.5, -DM 0.5: DX 0 → ADX 50
      [10, 8, 8.5], // -DM 1, TR 2 → TR 2.0625, +DM 0.25, -DM 0.75: +DI 12.12, -DI 36.36, DX 50
    ]);
    const spec: IndicatorSpec = { type: 'adx', period: 2 };
    expect(round(out(spec, data, 'adx'), 4)).toEqual([null, null, null, 50, 50]);
    // +DI exists from the third candle (57.14) but waits for the ADX.
    expect(round(out(spec, data, 'plusDi'), 4)).toEqual([null, null, null, 23.5294, 12.1212]);
    expect(round(out(spec, data, 'minusDi'), 4)).toEqual([null, null, null, 23.5294, 36.3636]);
    expect(minCandles(spec)).toBe(4);
  });

  it('stochastic(3,2,2): %K over the high-low range, smoothed, then %D', () => {
    const data = candles([
      [5, 1, 3],
      [6, 2, 5],
      [7, 3, 6], // range 1..7: raw 100 x 5/6 = 83.33
      [8, 4, 4], // range 2..8: raw 100 x 2/6 = 33.33 → %K 58.33 (held back for %D's warm-up)
      [6, 4, 5], // range 3..8: raw 100 x 2/5 = 40 → %K 36.67, %D 47.5
    ]);
    const spec: IndicatorSpec = { type: 'stochastic', k: 3, d: 2, smooth: 2 };
    expect(round(out(spec, data, 'k'), 2)).toEqual([null, null, null, null, 36.67]);
    expect(round(out(spec, data, 'd'), 2)).toEqual([null, null, null, null, 47.5]);
    expect(minCandles(spec)).toBe(5);
  });

  it('bollinger(3,2): population sigma, %b and bandwidth', () => {
    // mean 2, sigma sqrt(2/3) = 0.81650; bands 2 ± 1.63299.
    const spec: IndicatorSpec = { type: 'bollinger', period: 3, stddev: 2 };
    const data = fromCloses([1, 2, 3]);
    expect(round(out(spec, data, 'upper'), 5).at(-1)).toBe(3.63299);
    expect(round(out(spec, data, 'middle'), 5).at(-1)).toBe(2);
    expect(round(out(spec, data, 'lower'), 5).at(-1)).toBe(0.36701);
    // (3 - 0.36701) / 3.26599 and 3.26599 / 2.
    expect(round(out(spec, data, 'percentB'), 5).at(-1)).toBe(0.80619);
    expect(round(out(spec, data, 'bandwidth'), 5).at(-1)).toBe(1.63299);
  });

  it('vwap: typical price weighted by volume, from the first candle', () => {
    const data = candles([
      [3, 1, 2, 0], // no volume yet: no VWAP
      [3, 1, 2, 10], // typical 2
      [6, 4, 5, 30], // typical 5 → (20 + 150) / 40 = 4.25
    ]);
    expect(out({ type: 'vwap' }, data)).toEqual([NaN, 2, 4.25]);
  });

  it('obv adds volume on an up close, subtracts on a down close, ignores a flat one', () => {
    const data = candles([
      [10, 10, 10, 5],
      [11, 11, 11, 3],
      [10.5, 10.5, 10.5, 4],
      [10.5, 10.5, 10.5, 2],
      [12, 12, 12, 6],
    ]);
    expect(out({ type: 'obv' }, data)).toEqual([NaN, 3, -1, -1, 5]);
  });

  it("force_index(2): Elder's EMA of close change x volume", () => {
    // raw: (11-10) 3 = 3, (10.5-11) 4 = -2, (12-10.5) 6 = 9.
    // EMA2: seed (3 - 2) / 2 = 0.5, then 0.5 + 2/3 (9 - 0.5) = 6.1667.
    const data = candles([
      [10, 10, 10, 5],
      [11, 11, 11, 3],
      [10.5, 10.5, 10.5, 4],
      [12, 12, 12, 6],
    ]);
    expect(round(out({ type: 'force_index', period: 2 }, data), 4)).toEqual([
      null,
      null,
      0.5,
      6.1667,
    ]);
  });

  it('elder_ray(2): high and low against the EMA', () => {
    // EMA2: 1.5, then 1.5 + 2/3 (4 - 1.5) = 3.1667; bull 5 - 3.1667, bear 3 - 3.1667.
    const data = candles([
      [1.5, 0.5, 1],
      [2.5, 1.5, 2],
      [5, 3, 4],
    ]);
    const spec: IndicatorSpec = { type: 'elder_ray', period: 2 };
    expect(round(out(spec, data, 'bullPower'), 4)).toEqual([null, 1, 1.8333]);
    expect(round(out(spec, data, 'bearPower'), 4)).toEqual([null, 0, -0.1667]);
  });
});

describe('edge cases', () => {
  const flat = candles(new Array(40).fill([5, 5, 5, 2]));

  it.each<[IndicatorSpec, string, number]>([
    [{ type: 'rsi', period: 14 }, 'value', 50],
    [{ type: 'stochastic', k: 14, d: 3, smooth: 3 }, 'k', 50],
    [{ type: 'bollinger', period: 20, stddev: 2 }, 'percentB', 0.5],
    [{ type: 'bollinger', period: 20, stddev: 2 }, 'bandwidth', 0],
    [{ type: 'atr', period: 14 }, 'value', 0],
    [{ type: 'adx', period: 14 }, 'adx', 0],
    [{ type: 'adx', period: 14 }, 'plusDi', 0],
    [{ type: 'macd', fast: 12, slow: 26, signal: 9 }, 'histogram', 0],
    [{ type: 'force_index', period: 13 }, 'value', 0],
    [{ type: 'obv' }, 'value', 0],
  ])('a flat series gives %o its neutral %s', (spec, name, expected) => {
    expect(out(spec, flat, name).at(-1)).toBe(expected);
  });

  it('a series that only rises has RSI 100', () => {
    expect(rsi([1, 2, 3, 4], 3).at(-1)).toBe(100);
  });

  it('too few candles leave every output empty', () => {
    const specs: IndicatorSpec[] = [
      { type: 'sma', period: 20 },
      { type: 'ema', period: 20 },
      { type: 'macd', fast: 12, slow: 26, signal: 9 },
      { type: 'rsi', period: 14 },
      { type: 'stochastic', k: 14, d: 3, smooth: 3 },
      { type: 'atr', period: 14 },
      { type: 'bollinger', period: 20, stddev: 2 },
      { type: 'adx', period: 14 },
      { type: 'force_index', period: 13 },
      { type: 'elder_ray', period: 13 },
    ];
    for (const spec of specs) {
      const short = flat.slice(0, minCandles(spec) - 1);
      for (const output of Object.values(computeIndicator(spec, short).outputs)) {
        expect(output.values.every((v) => Number.isNaN(v))).toBe(true);
      }
      // And exactly enough gives a value at the newest candle.
      const enough = flat.slice(0, minCandles(spec));
      for (const output of Object.values(computeIndicator(spec, enough).outputs)) {
        expect(Number.isFinite(output.values.at(-1))).toBe(true);
      }
    }
  });

  it('no candles at all is not an error', () => {
    expect(out({ type: 'vwap' }, [])).toEqual([]);
    expect(out({ type: 'ema', period: 3 }, [])).toEqual([]);
  });

  it('counts missing candles', () => {
    const data = candles([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]).map((c, i) => ({ ...c, t: [0, HOUR, 4 * HOUR][i]! }));
    expect(countGaps(data, HOUR)).toBe(2);
    expect(countGaps(fromCloses([1, 2, 3]), HOUR)).toBe(0);
  });
});

describe('formatValue', () => {
  it.each<[number, Parameters<typeof formatValue>[1], number, string | null]>([
    [3.123456789, 'price', 4, '3.123457'],
    [3.1, 'price', 4, '3.1'],
    [-0.0000001, 'price', 4, '0'],
    [-0.012345, 'price', 2, '-0.0123'],
    [70.5345, 'oscillator', 4, '70.53'],
    [0.806186, 'ratio', 4, '0.8062'],
    [1234567.89, 'volume', 4, '1234568'],
    [0.000123456789, 'volume', 4, '0.000123457'],
    [12.5, 'volume', 4, '12.5'],
    [NaN, 'price', 4, null],
  ])('%d as %s at %d decimals is %s', (value, unit, decimals, expected) => {
    expect(formatValue(value, unit, decimals)).toBe(expected);
  });

  it('reads tick precision', () => {
    expect(decimalsOf('0.0001')).toBe(4);
    expect(decimalsOf('0.10')).toBe(1);
    expect(decimalsOf('1')).toBe(0);
  });
});

describe('summarize', () => {
  const source = (closes: readonly number[]) =>
    fromCloses(closes).map((candle) => ({
      candle,
      closeTime: candle.t + HOUR - 1,
      close: String(candle.close),
    }));
  const options = { seriesLength: 3, priceDecimals: 2, widthMs: HOUR, nowMs: 10 * HOUR };

  it('shows the latest value, a short series ending with it, and the candle', () => {
    const summary = summarize(
      source([1, 2, 3, 4, 5]),
      [
        { type: 'sma', period: 2 },
        { type: 'sma', period: 2 }, // a duplicate is shown once
        { type: 'macd', fast: 2, slow: 3, signal: 2 },
      ],
      options,
    );
    expect(summary).toEqual({
      candles: 5,
      last: { t: 4 * HOUR, close: '5', closed: true },
      indicators: {
        'sma(2)': { value: '4.5', series: ['2.5', '3.5', '4.5'] },
        'macd(2,3,2)': {
          value: { line: '0.5', signal: '0.5', histogram: '0' },
          // The series never reaches back before the signal's warm-up.
          series: {
            line: ['0.5', '0.5'],
            signal: ['0.5', '0.5'],
            histogram: ['0', '0'],
          },
        },
      },
    });
  });

  it('never shows a value computed on too few candles', () => {
    const summary = summarize(source([1, 2, 3]), [{ type: 'rsi', period: 14 }], options);
    expect(summary.indicators['rsi(14)']).toEqual({ value: null, needs: 15, have: 3 });
    expect(summary.warnings).toEqual([expect.stringMatching(/rsi\(14\) needs 15 candles/)]);
  });

  it('flags an open candle, gaps, a flat market and a VWAP without volume', () => {
    const data = source([2, 2, 2]).map((s, i) => ({
      ...s,
      candle: { ...s.candle, t: i === 2 ? 5 * HOUR : s.candle.t, volume: 0 },
      closeTime: i === 2 ? 6 * HOUR - 1 : s.closeTime,
    }));
    const summary = summarize(data, [{ type: 'vwap' }], { ...options, nowMs: 5 * HOUR + 1 });
    expect(summary.last).toEqual({ t: 5 * HOUR, close: '2', closed: false });
    expect(summary.indicators['vwap']).toEqual({ value: null, series: [null, null, null] });
    expect(summary.warnings).toEqual([
      expect.stringMatching(/^vwap has no value/),
      expect.stringMatching(/^3 candle\(s\) missing/),
      expect.stringMatching(/has not moved/),
    ]);
  });

  it('handles an empty window', () => {
    const summary = summarize([], [{ type: 'obv' }], options);
    expect(summary).toMatchObject({ candles: 0, last: null, indicators: { obv: { value: null } } });
  });
});
