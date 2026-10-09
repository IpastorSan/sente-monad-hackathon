/**
 * Technical indicators over candles, for the `get_indicators` tool (SEN-180).
 * Pure: no venue, no Nest, no clock. Models compute these badly from raw
 * klines, so the tool hands them the finished numbers.
 *
 * This is analysis, not money: the math runs in floating point and the tool
 * rounds the result for display. Nothing here prices an order.
 *
 * Conventions, chosen to match TA-Lib and the published worked examples the
 * spec checks against:
 * - Every output series is aligned with the input candles. `NaN` marks a
 *   candle before the indicator has warmed up — before ALL its outputs have,
 *   so MACD's line waits for its signal — and is never shown as a value.
 * - EMA is seeded with the SMA of its first `period` inputs, k = 2 / (period + 1).
 * - "Wilder" smoothing (RSI, ATR, ADX) is seeded with the mean of the first
 *   `period` inputs, then `prev + (x - prev) / period`.
 * - True range needs the previous close, so it starts at the second candle.
 * - Bollinger uses the population standard deviation, as Bollinger specifies.
 * - A ratio with a zero denominator takes its neutral value: RSI 50 on a flat
 *   series (100 when it only rose), stochastic %K 50 on a flat range, %b 0.5
 *   when the bands collapse, DI and DX 0 with no movement.
 * - VWAP and OBV are anchored at the first candle given: they depend on the
 *   window, not on the market's whole history.
 */

export interface Candle {
  /** Open time, Unix ms. */
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Base units. */
  readonly volume: number;
}

export type IndicatorSpec =
  | { readonly type: 'sma' | 'ema' | 'wma'; readonly period: number }
  | {
      readonly type: 'macd';
      readonly fast: number;
      readonly slow: number;
      readonly signal: number;
    }
  | { readonly type: 'rsi'; readonly period: number }
  | {
      readonly type: 'stochastic';
      readonly k: number;
      readonly d: number;
      readonly smooth: number;
    }
  | { readonly type: 'atr'; readonly period: number }
  | { readonly type: 'bollinger'; readonly period: number; readonly stddev: number }
  | { readonly type: 'vwap' }
  | { readonly type: 'obv' }
  | { readonly type: 'adx'; readonly period: number }
  | { readonly type: 'force_index'; readonly period: number }
  | { readonly type: 'elder_ray'; readonly period: number };

export type IndicatorType = IndicatorSpec['type'];

/** How an output is rounded for display. */
export type OutputUnit =
  /** Quote units, like the candles' prices. */
  | 'price'
  /** A 0-100 oscillator. */
  | 'oscillator'
  /** A dimensionless ratio such as %b. */
  | 'ratio'
  /** Volume-weighted: base units, or price x volume. */
  | 'volume';

export interface IndicatorOutput {
  readonly unit: OutputUnit;
  /** Aligned with the candles; `NaN` before warm-up. */
  readonly values: readonly number[];
}

export interface IndicatorResult {
  /** e.g. `macd(12,26,9)`: what the model asked for, with defaults filled in. */
  readonly label: string;
  /** Candles needed before the first value exists. */
  readonly minCandles: number;
  readonly outputs: Readonly<Record<string, IndicatorOutput>>;
}

// ---------------------------------------------------------------------------
// Primitives. Each takes and returns a series aligned with its input; `NaN`
// entries at the front are "not yet", and the computation starts after them.

function firstFinite(values: readonly number[]): number {
  const index = values.findIndex(Number.isFinite);
  return index === -1 ? values.length : index;
}

function blank(length: number): number[] {
  return new Array<number>(length).fill(NaN);
}

export function sma(values: readonly number[], period: number): number[] {
  const out = blank(values.length);
  const start = firstFinite(values);
  let sum = 0;
  for (let i = start; i < values.length; i++) {
    sum += values[i]!;
    if (i - start >= period) sum -= values[i - period]!;
    if (i - start >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function wma(values: readonly number[], period: number): number[] {
  const out = blank(values.length);
  const start = firstFinite(values);
  const weights = (period * (period + 1)) / 2;
  for (let i = start + period - 1; i < values.length; i++) {
    let sum = 0;
    for (let w = 1; w <= period; w++) sum += values[i - period + w]! * w;
    out[i] = sum / weights;
  }
  return out;
}

/** Seeded with the mean of the first `period` values, then `prev + alpha (x - prev)`. */
function smoothed(values: readonly number[], period: number, alpha: number): number[] {
  const out = blank(values.length);
  const start = firstFinite(values);
  const seedAt = start + period - 1;
  if (seedAt >= values.length) return out;
  let prev = 0;
  for (let i = start; i <= seedAt; i++) prev += values[i]!;
  prev /= period;
  out[seedAt] = prev;
  for (let i = seedAt + 1; i < values.length; i++) {
    prev += alpha * (values[i]! - prev);
    out[i] = prev;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  return smoothed(values, period, 2 / (period + 1));
}

export function wilder(values: readonly number[], period: number): number[] {
  return smoothed(values, period, 1 / period);
}

/** True range; `NaN` at the first candle, which has no previous close. */
export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return NaN;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

function rollingExtreme(values: readonly number[], period: number, pick: 'max' | 'min'): number[] {
  const out = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    out[i] = pick === 'max' ? Math.max(...window) : Math.min(...window);
  }
  return out;
}

function zip(a: readonly number[], b: readonly number[], f: (x: number, y: number) => number) {
  return a.map((x, i) => (Number.isFinite(x) && Number.isFinite(b[i]!) ? f(x, b[i]!) : NaN));
}

// ---------------------------------------------------------------------------
// Indicators

export function labelOf(spec: IndicatorSpec): string {
  switch (spec.type) {
    case 'macd':
      return `macd(${spec.fast},${spec.slow},${spec.signal})`;
    case 'stochastic':
      return `stochastic(${spec.k},${spec.d},${spec.smooth})`;
    case 'bollinger':
      return `bollinger(${spec.period},${spec.stddev})`;
    case 'vwap':
    case 'obv':
      return spec.type;
    default:
      return `${spec.type}(${spec.period})`;
  }
}

/** Candles an indicator needs before its first value. */
export function minCandles(spec: IndicatorSpec): number {
  switch (spec.type) {
    case 'sma':
    case 'ema':
    case 'wma':
    case 'bollinger':
    case 'elder_ray':
      return spec.period;
    case 'rsi':
    case 'atr':
    case 'force_index':
      return spec.period + 1;
    case 'macd':
      return spec.slow + spec.signal - 1;
    case 'stochastic':
      return spec.k + spec.smooth + spec.d - 2;
    case 'adx':
      return 2 * spec.period;
    case 'vwap':
      return 1;
    case 'obv':
      return 2;
  }
}

const out = (unit: OutputUnit, values: readonly number[]): IndicatorOutput => ({ unit, values });

export function computeIndicator(spec: IndicatorSpec, candles: readonly Candle[]): IndicatorResult {
  // One warm-up for the whole indicator: MACD's line exists before its
  // signal, and is not shown before it either.
  const needs = minCandles(spec);
  const outputs = Object.fromEntries(
    Object.entries(outputsOf(spec, candles)).map(([name, output]) => [
      name,
      out(
        output.unit,
        output.values.map((v, i) => (i < needs - 1 ? NaN : v)),
      ),
    ]),
  );
  return { label: labelOf(spec), minCandles: needs, outputs };
}

function outputsOf(
  spec: IndicatorSpec,
  candles: readonly Candle[],
): Record<string, IndicatorOutput> {
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  switch (spec.type) {
    case 'sma':
      return { value: out('price', sma(close, spec.period)) };
    case 'ema':
      return { value: out('price', ema(close, spec.period)) };
    case 'wma':
      return { value: out('price', wma(close, spec.period)) };
    case 'macd': {
      const line = zip(ema(close, spec.fast), ema(close, spec.slow), (f, s) => f - s);
      const signal = ema(line, spec.signal);
      return {
        line: out('price', line),
        signal: out('price', signal),
        histogram: out(
          'price',
          zip(line, signal, (l, s) => l - s),
        ),
      };
    }
    case 'rsi':
      return { value: out('oscillator', rsi(close, spec.period)) };
    case 'stochastic': {
      const highest = rollingExtreme(high, spec.k, 'max');
      const lowest = rollingExtreme(low, spec.k, 'min');
      const raw = close.map((c, i) => {
        const hh = highest[i]!;
        const ll = lowest[i]!;
        if (!Number.isFinite(hh)) return NaN;
        return hh === ll ? 50 : (100 * (c - ll)) / (hh - ll);
      });
      const k = sma(raw, spec.smooth);
      return { k: out('oscillator', k), d: out('oscillator', sma(k, spec.d)) };
    }
    case 'atr':
      return { value: out('price', wilder(trueRange(candles), spec.period)) };
    case 'bollinger': {
      const middle = sma(close, spec.period);
      const sd = middle.map((m, i) => {
        if (!Number.isFinite(m)) return NaN;
        let squares = 0;
        for (let j = i - spec.period + 1; j <= i; j++) squares += (close[j]! - m) ** 2;
        return Math.sqrt(squares / spec.period);
      });
      const upper = zip(middle, sd, (m, s) => m + spec.stddev * s);
      const lower = zip(middle, sd, (m, s) => m - spec.stddev * s);
      const width = zip(upper, lower, (u, l) => u - l);
      return {
        upper: out('price', upper),
        middle: out('price', middle),
        lower: out('price', lower),
        percentB: out(
          'ratio',
          width.map((w, i) => (w === 0 ? 0.5 : (close[i]! - lower[i]!) / w)),
        ),
        bandwidth: out(
          'ratio',
          zip(width, middle, (w, m) => w / m),
        ),
      };
    }
    case 'vwap': {
      let pv = 0;
      let volume = 0;
      const values = candles.map((c) => {
        pv += ((c.high + c.low + c.close) / 3) * c.volume;
        volume += c.volume;
        return volume > 0 ? pv / volume : NaN;
      });
      return { value: out('price', values) };
    }
    case 'obv': {
      let total = 0;
      const values = candles.map((c, i) => {
        if (i > 0) total += Math.sign(c.close - candles[i - 1]!.close) * c.volume;
        return total;
      });
      return { value: out('volume', values) };
    }
    case 'adx':
      return adx(candles, spec.period);
    case 'force_index': {
      const raw = candles.map((c, i) =>
        i === 0 ? NaN : (c.close - candles[i - 1]!.close) * c.volume,
      );
      return { value: out('volume', ema(raw, spec.period)) };
    }
    case 'elder_ray': {
      const average = ema(close, spec.period);
      return {
        ema: out('price', average),
        bullPower: out(
          'price',
          zip(high, average, (h, e) => h - e),
        ),
        bearPower: out(
          'price',
          zip(low, average, (l, e) => l - e),
        ),
      };
    }
  }
}

export function rsi(close: readonly number[], period: number): number[] {
  const change = close.map((c, i) => (i === 0 ? NaN : c - close[i - 1]!));
  const gain = wilder(
    change.map((x) => (Number.isFinite(x) ? Math.max(x, 0) : NaN)),
    period,
  );
  const loss = wilder(
    change.map((x) => (Number.isFinite(x) ? Math.max(-x, 0) : NaN)),
    period,
  );
  return zip(gain, loss, (g, l) => {
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  });
}

function adx(candles: readonly Candle[], period: number): Record<string, IndicatorOutput> {
  // [up move, down move] from the previous candle; none for the first.
  const moves = candles.map((c, i) =>
    i === 0 ? [NaN, NaN] : [c.high - candles[i - 1]!.high, candles[i - 1]!.low - c.low],
  );
  const dm = (pick: (up: number, down: number) => number) =>
    moves.map(([up, down]) => (Number.isNaN(up) ? NaN : pick(up!, down!)));
  const plusDm = dm((up, down) => (up > down && up > 0 ? up : 0));
  const minusDm = dm((up, down) => (down > up && down > 0 ? down : 0));
  // Wilder smooths running SUMS; smoothing means instead scales numerator and
  // denominator alike, so the DI ratios are the same.
  const tr = wilder(trueRange(candles), period);
  const di = (dm: readonly number[]) =>
    zip(wilder(dm, period), tr, (m, t) => (t === 0 ? 0 : (100 * m) / t));
  const plusDi = di(plusDm);
  const minusDi = di(minusDm);
  const dx = zip(plusDi, minusDi, (p, m) => (p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m)));
  return {
    adx: out('oscillator', wilder(dx, period)),
    plusDi: out('oscillator', plusDi),
    minusDi: out('oscillator', minusDi),
  };
}

// ---------------------------------------------------------------------------
// Series checks and display

/**
 * Missing candles between consecutive ones. A venue skips an interval with no
 * trades, and every indicator here treats the series as contiguous.
 */
export function countGaps(candles: readonly Candle[], widthMs: number): number {
  let missing = 0;
  for (let i = 1; i < candles.length; i++) {
    const step = Math.round((candles[i]!.t - candles[i - 1]!.t) / widthMs);
    if (step > 1) missing += step - 1;
  }
  return missing;
}

const OSCILLATOR_DECIMALS = 2;
const RATIO_DECIMALS = 4;
const VOLUME_SIGNIFICANT = 6;
const MAX_DECIMALS = 12;

/**
 * A number as a plain decimal string for the model, or null when there is
 * none. `priceDecimals` is the market's tick precision; averages get two more
 * places so a moving average sits between ticks.
 */
export function formatValue(value: number, unit: OutputUnit, priceDecimals: number): string | null {
  if (!Number.isFinite(value)) return null;
  let decimals: number;
  switch (unit) {
    case 'price':
      decimals = priceDecimals + 2;
      break;
    case 'oscillator':
      decimals = OSCILLATOR_DECIMALS;
      break;
    case 'ratio':
      decimals = RATIO_DECIMALS;
      break;
    case 'volume': {
      const magnitude = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value))) + 1;
      decimals = VOLUME_SIGNIFICANT - magnitude;
      break;
    }
  }
  decimals = Math.min(Math.max(decimals, 0), MAX_DECIMALS);
  if (Math.abs(value) >= 1e21) return BigInt(Math.round(value)).toString();
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

// ---------------------------------------------------------------------------
// What the tool returns for one timeframe

export type ShownValue = string | null | Readonly<Record<string, string | null>>;
export type ShownSeries =
  readonly (string | null)[] | Readonly<Record<string, readonly (string | null)[]>>;

export type ShownIndicator =
  | { readonly value: ShownValue; readonly series: ShownSeries }
  | { readonly value: null; readonly needs: number; readonly have: number };

/** One candle as the venue reported it, and parsed for the math. */
export interface SourceCandle {
  readonly candle: Candle;
  /** Unix ms; the candle has closed once this is in the past. */
  readonly closeTime: number;
  /** The venue's own close, shown as is. */
  readonly close: string;
}

export interface TimeframeSummary {
  /** Candles the indicators were computed on. */
  readonly candles: number;
  /** The newest candle: every `value` is computed on its close. */
  readonly last: { readonly t: number; readonly close: string; readonly closed: boolean } | null;
  readonly indicators: Readonly<Record<string, ShownIndicator>>;
  readonly warnings?: readonly string[];
}

export interface SummaryOptions {
  /** How many recent values each `series` carries, the latest last. */
  readonly seriesLength: number;
  /** Digits after the point in the market's tick size. */
  readonly priceDecimals: number;
  /** Candle width, to spot missing candles. */
  readonly widthMs: number;
  /** Unix ms, to tell whether the newest candle has closed. */
  readonly nowMs: number;
}

/**
 * Every spec over one timeframe's candles (oldest first), shaped for the
 * model: the latest value, a short recent series, and warnings. A spec the
 * candles cannot warm up shows `value: null` with what it needs, never a
 * value computed on too little data.
 */
export function summarize(
  source: readonly SourceCandle[],
  specs: readonly IndicatorSpec[],
  options: SummaryOptions,
): TimeframeSummary {
  const candles = source.map((s) => s.candle);
  const warnings: string[] = [];
  const indicators: Record<string, ShownIndicator> = {};
  const fmt = (value: number | undefined, unit: OutputUnit) =>
    formatValue(value ?? NaN, unit, options.priceDecimals);

  for (const spec of specs) {
    const label = labelOf(spec);
    if (label in indicators) continue;
    const result = computeIndicator(spec, candles);
    if (candles.length < result.minCandles) {
      indicators[label] = { value: null, needs: result.minCandles, have: candles.length };
      warnings.push(
        `${label} needs ${result.minCandles} candles and only ${candles.length} exist, so it ` +
          'has no value. Raise lookback or use a longer timeframe.',
      );
      continue;
    }
    const from = Math.max(candles.length - options.seriesLength, result.minCandles - 1);
    const shown = Object.entries(result.outputs).map(([name, output]) => ({
      name,
      value: fmt(output.values.at(-1), output.unit),
      series: output.values.slice(from).map((v) => fmt(v, output.unit)),
    }));
    const single = shown.length === 1 && shown[0]!.name === 'value' ? shown[0]! : undefined;
    indicators[label] = single
      ? { value: single.value, series: single.series }
      : {
          value: Object.fromEntries(shown.map((s) => [s.name, s.value])),
          series: Object.fromEntries(shown.map((s) => [s.name, s.series])),
        };
    if (spec.type === 'vwap' && single?.value === null) {
      warnings.push('vwap has no value: no volume was reported in this window.');
    }
  }

  const gaps = countGaps(candles, options.widthMs);
  if (gaps > 0) {
    warnings.push(
      `${gaps} candle(s) missing inside the window (no trades in those intervals); the ` +
        'indicators treat the series as contiguous.',
    );
  }
  if (candles.length > 1 && candles.every((c) => c.close === candles[0]!.close)) {
    warnings.push('Every close in this window is the same: the market has not moved.');
  }
  const newest = source.at(-1);
  return {
    candles: candles.length,
    last: newest
      ? { t: newest.candle.t, close: newest.close, closed: newest.closeTime < options.nowMs }
      : null,
    indicators,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
