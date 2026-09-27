/**
 * The choices behind the trading kit (SEN-108): how a price, a change, a
 * freshness stamp and a leverage tag read. Plain node, no React Native, so
 * `tradingFormat.test.ts` runs with no device; `trading.tsx` only lays out.
 *
 * Prices stay decimal strings until the last step: a tick-rounded price is
 * computed on bigints so `0.9812` never comes back as `0.98119999`. Percent
 * changes and the order-book split are display-only ratios, so they may go
 * through a float.
 */
import { formatPrice as formatPlaces, priceDecimals, type Decimal } from './chart/geometry.ts';

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;
/** A true minus, as the chart pill prints it; a hyphen reads as a dash. */
const MINUS = '−';

/**
 * A price split for `BigNumber`: the part at full weight and the dimmed
 * decimals, e.g. `1,284.5` at 2 places → `{ whole: '1,284', fraction: '.50' }`.
 * `null` for something that is not a plain decimal.
 */
export function splitDecimals(
  value: Decimal,
  places: number,
): { whole: string; fraction: string } | null {
  const formatted = formatPlaces(value, places);
  if (formatted === null) return null;
  const dot = formatted.indexOf('.');
  return dot === -1
    ? { whole: formatted, fraction: '' }
    : { whole: formatted.slice(0, dot), fraction: formatted.slice(dot) };
}

/**
 * A price on the market's tick grid, grouped: `formatPrice('64188.46', '0.5')`
 * → `64,188.5`. The tick sets both the step and the decimals shown, so a row
 * never claims precision the venue doesn't quote. Without a tick it falls
 * back to the chart's rule (4 places under 10, else 2), so a row and the chart
 * pill beside it agree. Rounds half away from zero, on the digits.
 */
export function formatPrice(value: Decimal, tick?: Decimal): string | null {
  const v = DECIMAL.exec(value.trim());
  if (!v) return null;
  if (tick === undefined) return formatPlaces(value, priceDecimals(Number(value)));
  const t = DECIMAL.exec(tick.trim());
  if (!t || t[1] === '-') return null;
  const [, sign = '', whole = '0', fraction = ''] = v;
  const [, , tickWhole = '0', tickFraction = ''] = t;
  const places = tickFraction.replace(/0+$/, '').length;
  // Work at the finer of the two precisions so the rounding happens once.
  const scale = Math.max(places, fraction.length);
  const atoms = BigInt(whole + fraction.padEnd(scale, '0'));
  const step = BigInt(tickWhole + tickFraction.padEnd(scale, '0').slice(0, scale));
  if (step === 0n) return null;
  let steps = atoms / step;
  if ((atoms % step) * 2n >= step) steps += 1n;
  const rounded = (steps * step) / 10n ** BigInt(scale - places);
  const text = formatPlaces(
    places === 0
      ? rounded.toString()
      : `${rounded / 10n ** BigInt(places)}.${(rounded % 10n ** BigInt(places)).toString().padStart(places, '0')}`,
    places,
  );
  if (text === null) return null;
  return sign === '-' && rounded !== 0n ? `${MINUS}${text}` : text;
}

/** Percent change from `from` to `to`, or `null` when there is no base to measure against. */
export function pctChange(from: Decimal, to: Decimal): number | null {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

export type Direction = 'up' | 'down' | 'flat';

/**
 * `+2.41%`, `−1.12%`, `0.00%`. The sign comes from the ROUNDED figure, so a
 * change that prints as zero is never painted mint or berry.
 */
export function formatPct(pct: number | null, places = 2): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const shown = Math.abs(pct).toFixed(places);
  const direction = pctDirection(pct, places);
  return `${direction === 'up' ? '+' : direction === 'down' ? MINUS : ''}${shown}%`;
}

/** The direction colour for a change: mint, berry, or neither when it rounds to zero. */
export function pctDirection(pct: number | null, places = 2): Direction {
  if (pct === null || !Number.isFinite(pct)) return 'flat';
  if (Number(Math.abs(pct).toFixed(places)) === 0) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

/**
 * `as of 3s` / `2m` / `1h` / `4d` since the data was fetched. A timestamp in
 * the future (device clock behind the server) reads as `0s`, not negative.
 */
export function asOfLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `as of ${s}s`;
  if (s < 3600) return `as of ${Math.floor(s / 60)}m`;
  if (s < 86_400) return `as of ${Math.floor(s / 3600)}h`;
  return `as of ${Math.floor(s / 86_400)}d`;
}

/**
 * When the live dot stops breathing. Polling runs every few seconds (U-4), so
 * 30 s without a fresh answer means the numbers on screen are no longer live.
 */
export const STALE_AFTER_MS = 30_000;

export function isStale(ms: number, now: number, afterMs = STALE_AFTER_MS): boolean {
  return now - ms > afterMs;
}

/** `PERP 20×`, `PERP 2.5×`; plain `PERP` when the max leverage is unknown. */
export function leverageTag(n?: number | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) return 'PERP';
  return `PERP ${Number(n.toFixed(2))}×`;
}

/**
 * Tints for the token stone. The study's pastels, keyed by base asset; the
 * letter on an `ink` face has to read on every one of them, so the list stays
 * light. No third-party logos: a logo is a claim about who issued the token.
 */
const TOKEN_TINTS: Record<string, string> = {
  MON: '#DDD7FE',
  ETH: '#CFD6FF',
  BTC: '#FFD9A8',
  DOGE: '#F0E0B8',
  AVAX: '#FFC2CC',
  SOL: '#C9F2E4',
  XAU: '#F5E3A3',
};
const FALLBACK_TINT = '#DDD7FE';

/**
 * The letter and tint of a token's stone. Wrapper prefixes are lower-case
 * (`cbBTC`) or a lone `W` (`WETH`), so the letter is the first capital of the
 * base asset and `cbBTC`, `WBTC` and `BTC` share a stone.
 */
export function glyphFor(symbol: string): { letter: string; tint: string } {
  const bare = symbol.replace(/^[a-z]+/, '').replace(/-PERP$/i, '');
  const base = bare.replace(/^W(?=[A-Z]{3})/, '').replace(/[a-z]+$/, '');
  const letter = (base[0] ?? symbol[0] ?? '?').toUpperCase();
  return { letter, tint: TOKEN_TINTS[base.toUpperCase()] ?? FALLBACK_TINT };
}

/**
 * The bid/ask split as whole percents that always add to 100, or `null` for
 * an empty book (a 50/50 bar would claim a balance nobody quoted).
 */
export function pressureSplit(bids: Decimal, asks: Decimal): { bid: number; ask: number } | null {
  const b = Math.max(0, Number(bids) || 0);
  const a = Math.max(0, Number(asks) || 0);
  if (b + a === 0) return null;
  const bid = Math.round((b / (b + a)) * 100);
  return { bid, ask: 100 - bid };
}

/** A hidden balance keeps its shape: digits become dots, separators stay. */
export function maskDigits(text: string): string {
  return text.replace(/\d/g, '•');
}
