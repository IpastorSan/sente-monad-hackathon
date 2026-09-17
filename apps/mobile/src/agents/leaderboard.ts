/**
 * The leaderboard rows, as text (SEN-26).
 *
 * Pure: no React, no React Native, no fetch — `leaderboard.test.ts` runs it
 * under plain `node --test`, so what the board SAYS is pinned without a device
 * and without an API. Like `ledger.ts`, it restates its own input contract
 * rather than importing the API client's types.
 *
 * One rule holds this file together, and it is the feature's whole point:
 *
 * > **`rateWithSample` is the only way to print a win rate.**
 *
 * There is no exported function that turns `winRate` into a percentage on its
 * own, so no screen can show "62.5%" over two trades and no refactor can
 * accidentally drop the `n` beside it. The API's `n` is the same number the
 * row prints, because a rate without its sample is a lie.
 */
import { groupThousands } from './amounts.ts';

/** How many theses an agent settled (a boolean `held`), and how many it held. */
export type Theses = {
  readonly settled: number;
  readonly held: number;
  readonly open: number;
};

/**
 * `62.5% · n 8` — the rate AND its sample, inseparable by construction. The
 * one function allowed to print a percentage.
 *
 * A rate the API could not compute is not rendered as 0% or as 100%: it says
 * there is nothing settled yet, which is what it means.
 */
export function rateWithSample(winRate: number | null, n: number): string {
  if (winRate === null || n <= 0) return 'no settled trades';
  return `${percent(winRate)} · n ${groupThousands(String(n))}`;
}

/** `4.2%` / `−12.5%` / `—`. 1dp: the API rounds at 4, this is a display choice. */
export function roiLabel(roi: number | null): string {
  if (roi === null) return '—';
  if (roi === 0) return '0%';
  return `${roi < 0 ? '−' : '+'}${percent(Math.abs(roi))}`;
}

/** `+12.40` / `−3.10` / `0.00` — a real minus sign, grouped, rounded to the cent. */
export function pnlLabel(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const amount = amountLabel(value);
  if (parsed === 0) return amount;
  return parsed < 0 ? `−${amount}` : `+${amount}`;
}

/** `25.00`, unsigned: for a figure that cannot be negative, like capital deployed. */
export function amountLabel(value: string): string {
  const parsed = Number(value);
  // Hand back exactly what could not be parsed rather than inventing a number.
  if (!Number.isFinite(parsed)) return value;
  const [whole = '0', fraction = '00'] = Math.abs(parsed).toFixed(2).split('.');
  return `${groupThousands(whole)}.${fraction}`;
}

/** `01`, `12` — zero-padded so the column is a column. */
export function rankLabel(rank: number | null): string {
  if (rank === null) return '—';
  return rank < 10 ? `0${rank}` : String(rank);
}

/** `Kuru` / `Kuru · Perpl` / `not indexed yet`. */
export function venueLabel(venues: readonly string[]): string {
  if (venues.length === 0) return 'not indexed yet';
  return venues
    .map((venue) => (venue === '' ? venue : venue.charAt(0).toUpperCase() + venue.slice(1)))
    .join(' · ');
}

/**
 * The SEN-22 reading, with its own denominator on it: `2 of 3 theses held`.
 * Never a percentage, because it is not the same thing as the win rate and the
 * row already carries one.
 */
export function thesisLabel(theses: Theses): string {
  const open = theses.open > 0 ? ` · ${groupThousands(String(theses.open))} open` : '';
  if (theses.settled === 0) return `no settled theses${open}`;
  return `${theses.held} of ${groupThousands(String(theses.settled))} theses held${open}`;
}

/** `3 settled trades` — the threshold sentence for an unranked row. */
export function tooFewLabel(n: number, minTrades: number): string {
  const missing = Math.max(0, minTrades - n);
  const trades = missing === 1 ? 'trade' : 'trades';
  return `${missing} more settled ${trades} to be ranked`;
}

/** `62.5%`. Exported for the note text only; rows use `rateWithSample`. */
export function percent(rate: number): string {
  const tenths = Math.round(rate * 1000);
  const whole = Math.trunc(tenths / 10);
  const fraction = Math.abs(tenths % 10);
  return fraction === 0 ? `${whole}%` : `${whole}.${fraction}%`;
}
