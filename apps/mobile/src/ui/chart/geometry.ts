/**
 * The chart's geometry (SEN-107): every number `Chart.tsx` and `Sparkline.tsx`
 * draw, and nothing they draw it with.
 *
 * The reference is the study's `docs/design/trading/chart.js`: the same 6 %
 * scale padding, the same `fit: false` edge chips, the same candle body width,
 * the same right gutter sized to the last-price pill. Keeping it here, pure,
 * means `geometry.test.ts` pins those choices under plain node and the
 * components only lay out.
 *
 * Prices arrive as decimal strings (the wire contract never sends a float) and
 * become numbers HERE, because a pixel is a float anyway. What is shown to a
 * person — the level labels and the pill — goes back through `formatPrice`,
 * which works on the string, so a label never reads `0.9499999`.
 *
 * `nearestIndex` is a worklet: the scrub gesture calls it on the UI thread.
 */
import { groupThousands } from '../../agents/amounts.ts';

/** Exact decimal on the wire, never a float. */
export type Decimal = string;

/** The four prices a candle needs. `KlineDto` (plan-backend's wire contract) satisfies it. */
export type ChartKline = {
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
};

export type LevelKind = 'entry' | 'tp' | 'sl' | 'liq' | 'limit';

export type ChartLevel = {
  readonly price: Decimal;
  readonly kind: LevelKind;
  /** Upper-case by convention (`ENTRY`, `STOP · WATCHED`); the price is appended. */
  readonly label: string;
};

/** A price → y mapping. Plain data, so it can cross into a worklet. */
export type Scale = {
  readonly lo: number;
  readonly hi: number;
  /** y of `hi`. */
  readonly top: number;
  /** y of `lo`. */
  readonly bottom: number;
};

/**
 * A wire price as a number, or `NaN` when it is not one. `Number('')` is `0`,
 * which would draw a blank close as a crash to zero; `NaN` instead lets the
 * geometry below drop the sample (SEN-141). Infinities are not prices either.
 */
export function toPrice(value: Decimal): number {
  if (value.trim() === '') return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Fraction of the price span added above and below, so the line never touches an edge. */
export const SCALE_PADDING = 0.06;

/**
 * The vertical scale for a series.
 *
 * `values` is every price the series itself must show (closes, or highs and
 * lows for candles, plus a previous close). `levels` are the drawn price lines:
 * with `fit` (the default) they are pulled into the scale; with `fit: false`
 * they are not, so a far liquidation price cannot flatten the chart — it
 * becomes an edge chip instead (`levelLayout`).
 */
export function scaleFor(
  values: readonly number[],
  levels: readonly number[],
  {
    height,
    padTop,
    padBottom,
    fit = true,
  }: { height: number; padTop: number; padBottom: number; fit?: boolean },
): Scale {
  const all = fit ? [...values, ...levels] : [...values];
  const finite = all.filter(Number.isFinite);
  let lo = finite.length > 0 ? Math.min(...finite) : 0;
  let hi = finite.length > 0 ? Math.max(...finite) : 1;
  // A flat series still needs a span, or every y divides by zero.
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  lo -= span * SCALE_PADDING;
  hi += span * SCALE_PADDING;
  return { lo, hi, top: padTop, bottom: height - padBottom };
}

export function yOf(scale: Scale, price: number): number {
  return scale.top + (1 - (price - scale.lo) / (scale.hi - scale.lo)) * (scale.bottom - scale.top);
}

/**
 * x of sample `i` of `n` across a plot `width` wide. The first sample sits on
 * the left edge and the last on the right, as in chart.js; a lone sample sits
 * on the right, where "now" is.
 */
export function xOf(i: number, n: number, width: number): number {
  return n <= 1 ? width : (i / (n - 1)) * width;
}

/** The sample under `x`, clamped to the series. For the scrub, on the UI thread. */
export function nearestIndex(x: number, n: number, width: number): number {
  'worklet';
  if (n <= 1 || width <= 0) return 0;
  const i = Math.round((x / width) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/**
 * Each sample as a point, for the scrub dot and the markers. A sample that is
 * not a finite price holds the last good y (or the next one, before any) so the
 * scrub dot never lands on `NaN`; with no good sample at all it sits mid-plot
 * (SEN-141).
 */
export function pointsXY(
  points: readonly number[],
  scale: Scale,
  width: number,
): { x: number; y: number }[] {
  const firstGood = points.find(Number.isFinite);
  let held = firstGood === undefined ? (scale.top + scale.bottom) / 2 : yOf(scale, firstGood);
  return points.map((p, i) => {
    if (Number.isFinite(p)) held = yOf(scale, p);
    return { x: xOf(i, points.length, width), y: held };
  });
}

/**
 * The series as an SVG path (`M x,y L x,y …`), which Skia parses as is. A
 * sample that is not a finite price is dropped, so the line runs straight
 * between its neighbours: one `NaN` in a path makes Skia draw nothing (SEN-141).
 */
export function linePath(points: readonly number[], scale: Scale, width: number): string {
  const n = points.length;
  let path = '';
  points.forEach((p, i) => {
    if (!Number.isFinite(p)) return;
    path += `${path === '' ? 'M' : 'L'}${round1(xOf(i, n, width))},${round1(yOf(scale, p))}`;
  });
  return path;
}

/** The line closed down to the bottom of the canvas: what the gradient fills. */
export function areaPath(
  points: readonly number[],
  scale: Scale,
  width: number,
  height: number,
): string {
  // Closed under the first and last samples the line actually draws (SEN-141).
  const first = points.findIndex(Number.isFinite);
  if (first === -1) return '';
  const last = points.findLastIndex(Number.isFinite);
  const lastX = round1(xOf(last, points.length, width));
  const firstX = round1(xOf(first, points.length, width));
  return `${linePath(points, scale, width)}L${lastX},${height}L${firstX},${height}Z`;
}

export type CandleRect = {
  /** Centre x: the wick and the sample's x. */
  readonly x: number;
  readonly up: boolean;
  readonly wick: { readonly top: number; readonly bottom: number };
  readonly body: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
};

/**
 * One body and one wick per kline. The body is 62 % of a slot and never
 * thinner than 2 px or shorter than 1 px, so a doji is still a visible tick.
 * A candle that closed at its open counts as up, as chart.js has it. A kline
 * with any price that is not a finite number is skipped, its slot left empty,
 * rather than drawn as a `NaN` rect or a bar to zero (SEN-141).
 */
export function candleRects(
  klines: readonly ChartKline[],
  scale: Scale,
  width: number,
): CandleRect[] {
  const n = klines.length;
  const bodyWidth = Math.max(2, (width / Math.max(n, 1)) * 0.62);
  return klines.flatMap((k, i) => {
    const open = toPrice(k.open);
    const close = toPrice(k.close);
    const high = toPrice(k.high);
    const low = toPrice(k.low);
    if (![open, close, high, low].every(Number.isFinite)) return [];
    const x = xOf(i, n, width);
    const yOpen = yOf(scale, open);
    const yClose = yOf(scale, close);
    return {
      x,
      up: close >= open,
      wick: { top: yOf(scale, high), bottom: yOf(scale, low) },
      body: {
        x: x - bodyWidth / 2,
        y: Math.min(yOpen, yClose),
        width: bodyWidth,
        height: Math.max(1, Math.abs(yOpen - yClose)),
      },
    };
  });
}

export type LevelPlacement = {
  /** Where the dashed line is drawn, or the chip's text baseline when off the scale. */
  readonly y: number;
  readonly onScale: boolean;
  /** Which edge an off-scale level is pinned to, `null` when it is on the scale. */
  readonly edge: 'top' | 'bottom' | null;
};

/** Baseline of the first top chip (chart.js: 12) and inset of the first bottom one (4). */
const EDGE_TOP = 12;
const EDGE_BOTTOM_INSET = 4;
/** Chips on the same edge stack this far apart rather than overprint. */
export const EDGE_STEP = 12;

/**
 * Where each level goes. A level inside the scale is a line at its price; one
 * outside (only possible with `fit: false`) is a chip pinned to the edge it
 * lies beyond, stacked when several share an edge. `height` is the canvas's.
 */
export function levelLayout(
  levels: readonly number[],
  scale: Scale,
  height: number,
): LevelPlacement[] {
  let tops = 0;
  let bottoms = 0;
  return levels.map((price) => {
    if (price > scale.hi) {
      return { y: EDGE_TOP + EDGE_STEP * tops++, onScale: false, edge: 'top' };
    }
    if (price < scale.lo) {
      return {
        y: height - EDGE_BOTTOM_INSET - EDGE_STEP * bottoms++,
        onScale: false,
        edge: 'bottom',
      };
    }
    return { y: yOf(scale, price), onScale: true, edge: null };
  });
}

/**
 * The right gutter that holds the last-price pill, sized from the widest price
 * the pill could show so it does not jump while prices tick. chart.js's rule:
 * ~6.4 px per mono character plus 22 px of pill, never under 58.
 */
export function lastTagWidth(label: string): number {
  return Math.max(58, label.length * 6.4 + 22);
}

/** Price decimals by magnitude: four below 10 (MON at 0.9744), two above (ETH at 2,498.00). */
export function priceDecimals(price: number): number {
  return Math.abs(price) < 10 ? 4 : 2;
}

/**
 * A decimal string at a fixed number of places, grouped, rounded half-up on
 * the digits rather than through a float. `null` for something that is not a
 * plain decimal.
 */
export function formatPrice(value: Decimal, places: number): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const scaled = BigInt(whole + fraction.padEnd(places, '0').slice(0, places));
  const roundUp = (fraction[places] ?? '0') >= '5';
  const digits = (scaled + (roundUp ? 1n : 0n)).toString().padStart(places + 1, '0');
  const intPart = digits.slice(0, digits.length - places);
  const fracPart = digits.slice(digits.length - places);
  const negative = sign === '-' && /[1-9]/.test(digits);
  return `${negative ? '−' : ''}${groupThousands(intPart)}${places > 0 ? `.${fracPart}` : ''}`;
}

/** `true` when the series ended at or above where it is measured from. */
export function isUp(first: number, last: number): boolean {
  return last >= first;
}

/**
 * Resolves a marker index: negative counts back from the end; clamped to the
 * series. `null` when there is no sample to point at — an empty series, or an
 * index that is not a number — because clamping into `[0, -1]` gave `0`, a
 * sample that does not exist (SEN-141). A fractional index truncates.
 */
export function markerIndex(index: number, n: number): number | null {
  if (n <= 0 || !Number.isFinite(index)) return null;
  const whole = Math.trunc(index);
  const i = whole < 0 ? n + whole : whole;
  return Math.max(0, Math.min(n - 1, i));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
