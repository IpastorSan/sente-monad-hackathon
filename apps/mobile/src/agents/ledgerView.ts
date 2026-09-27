/**
 * What the Ledger SAYS about each entry (SEN-60): the stone it is placed as,
 * its headline, the line under it, and the three figures over the spine.
 *
 * Pure, like `ledger.ts` beside it — no React, no React Native — so
 * `ledgerView.test.ts` pins every string under plain `node --test`. The screen
 * only arranges what this returns; it does not format.
 *
 * `ledger.ts` owns the event → entry mapping and the formatters older screens
 * import; this owns the Goban reading of an entry. The split is where the
 * contract changes: that file answers "what happened", this one "how it reads".
 */
import { groupThousands } from './amounts.ts';
import { PNL_LABEL_PLACES, pnlLabel } from './leaderboard.ts';
import {
  depositAmount,
  venueLabel,
  type DepositEntry,
  type Direction,
  type LedgerEntry,
  type RefusalLayer,
  type ThesisEntry,
  type TradeEntry,
  type VerdictEntry,
} from './ledger.ts';
import { shortAddress } from '../ui/format.ts';
import { signedFigure } from '../ui/money.ts';

/**
 * The stone an entry is placed as — `StoneKind` in `ui/goban.tsx`, restated so
 * this file stays loadable under node. A verdict or a close is a half stone,
 * mint or berry by what the move was worth.
 */
export type LedgerStone = 'deposit' | 'thesis' | 'trade' | 'refusal' | 'win' | 'loss';

export function stoneFor(entry: LedgerEntry): LedgerStone {
  switch (entry.kind) {
    case 'deposit':
    case 'thesis':
    case 'trade':
    case 'refusal':
      return entry.kind;
    case 'verdict':
      return outcome(entry) === 'down' ? 'loss' : 'win';
  }
}

/**
 * Money that moved, read as up or down. The sign of the PnL decides; with no
 * number, SEN-22's `held` does; a flat verdict follows `held` too, because the
 * API calls a thesis that ended flat one that did not hold.
 */
export function outcome(entry: VerdictEntry): 'up' | 'down' | null {
  // Judged at the cent the headline prints (SEN-136): a P&L that reads `0.00`
  // is not a win or a loss, so the thesis' `held` decides instead.
  const tone = signedFigure(entry.pnl, PNL_LABEL_PLACES)?.tone ?? null;
  if (tone !== null) return tone;
  if (entry.held === true) return 'up';
  if (entry.held === false) return 'down';
  return null;
}

// ---------------------------------------------------------------------------
// Headlines

/** `Bought 180.00 MON` — the base asset of `MON-USDC`, never the pair. */
export function tradeHeadline(entry: TradeEntry): string {
  const amount = `${entry.size}${baseOf(entry.market)}`;
  if (!entry.filled) return `Didn’t fill: ${verbOf(entry.direction, 'order')} ${amount}`;
  return `${verbOf(entry.direction, 'past')} ${amount}`;
}

/**
 * `at 0.9744 · Kuru spot`, then leverage, and — for an order that did not land
 * — the venue's own status, so the row says plainly why.
 */
export function tradeDetail(entry: TradeEntry): string {
  const parts = [
    entry.price !== null ? `at ${entry.price}` : null,
    entry.venue !== null ? venueKind(entry.venue) : null,
    entry.leverage !== null ? `${entry.leverage}×` : null,
    !entry.filled && entry.status !== null ? entry.status : null,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** `Thesis · long MON-USDC`. */
export function thesisKind(entry: ThesisEntry): string {
  const direction = entry.direction !== null ? `${entry.direction} ` : '';
  return `Thesis · ${direction}${entry.market}`;
}

/** Who held the line. Pride, not an error — the pill is lilac, never berry. */
export function heldBy(layer: RefusalLayer): string {
  return layer === 'enclave' ? 'Held by the enclave' : 'Held by Sente';
}

/** `Closed long` and `+18.22`, apart, so the screen can tint only the figure. */
export function verdictHeadline(entry: VerdictEntry): {
  lead: string;
  pnl: string | null;
  tone: 'up' | 'down' | null;
} {
  const what = entry.direction ?? entry.market ?? 'position';
  return {
    lead: `Closed ${what}`,
    pnl: entry.pnl === null ? null : pnlLabel(entry.pnl),
    tone: outcome(entry),
  };
}

/** `Funded 500.00 USDC`, at the precision a balance of that asset shows. */
export function depositHeadline(entry: DepositEntry): string {
  const amount = depositAmount(entry).replace(/^\+/u, '');
  return `Funded ${amount}${entry.asset !== null ? ` ${entry.asset}` : ''}`;
}

/** `from 0x8f1d…7a30` — set in mono by the screen, because it is the chain's. */
export function depositSource(entry: DepositEntry): string | null {
  return entry.from !== null ? `from ${shortAddress(entry.from)}` : null;
}

/**
 * The time beside an entry: `14:02:11` on the day it happened, `Sep 21` once
 * it is older. UTC, like `clockTime`, so it reads the same on every device.
 */
export function entryTime(at: number, now: number = Date.now()): string {
  const iso = new Date(at).toISOString();
  if (iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return iso.slice(11, 19);
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7);
  return `${month} ${Number(iso.slice(8, 10))}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// The three figures

export type LedgerStats = {
  /** Fills that landed — the count `GET /agents/summaries` calls `trades`. */
  trades: number;
  /** Refusals, both layers: each is the mandate holding. */
  held: number;
  /** Realised PnL summed exactly, as `+42.18`; `null` when nothing settled. */
  pnl: string | null;
  tone: 'up' | 'down' | null;
};

/**
 * Trades, Held and P&L over the entries on screen. The PnL is the VERDICTS'
 * only: a Perpl close is followed by the verdict it settles, and adding the
 * close's gross figure to the verdict's net one would count the trade twice.
 * Summed as exact decimals, because a column of cents added in floats drifts.
 */
export function ledgerStats(entries: readonly LedgerEntry[]): LedgerStats {
  let trades = 0;
  let held = 0;
  const pnls: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'trade' && entry.filled) trades += 1;
    else if (entry.kind === 'refusal') held += 1;
    else if (entry.kind === 'verdict' && entry.origin === 'verdict' && entry.pnl !== null) {
      pnls.push(entry.pnl);
    }
  }
  const total = sumDecimals(pnls);
  if (total === null) return { trades, held, pnl: null, tone: null };
  // Label and tone from one rounding (SEN-136): a total of -0.001 is `0.00`, untinted.
  const figure = signedFigure(total, PNL_LABEL_PLACES);
  return { trades, held, pnl: figure?.text ?? total, tone: figure?.tone ?? null };
}

/** `1,204` — the counts are grouped like every other figure in the app. */
export function countLabel(count: number): string {
  return groupThousands(String(count));
}

/**
 * Signed decimal strings summed exactly, or `null` when none of them parses.
 * One that does not parse is left out rather than read as zero.
 */
export function sumDecimals(values: readonly string[]): string | null {
  const parsed = values
    .map((value) => /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  if (parsed.length === 0) return null;
  const scale = Math.max(...parsed.map((match) => (match[3] ?? '').length));
  let total = 0n;
  for (const [, sign, whole = '0', fraction = ''] of parsed) {
    const atoms = BigInt(whole + fraction.padEnd(scale, '0'));
    total += sign === '-' ? -atoms : atoms;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

// ---------------------------------------------------------------------------
// Filters

export type LedgerFilter = 'all' | 'trades' | 'theses' | 'held';

export const LEDGER_FILTERS: readonly { value: LedgerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'trades', label: 'Trades' },
  { value: 'theses', label: 'Theses' },
  { value: 'held', label: 'Held' },
];

/** A close is a trade for this purpose; a deposit is only ever under All. */
export function inFilter(entry: LedgerEntry, filter: LedgerFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'trades':
      return entry.kind === 'trade' || entry.kind === 'verdict';
    case 'theses':
      return entry.kind === 'thesis';
    case 'held':
      return entry.kind === 'refusal';
  }
}

// ---------------------------------------------------------------------------

/** ` MON` for `MON-USDC` or `MON/USDC`; nothing when the market is unknown. */
function baseOf(market: string): string {
  const base = market.split(/[-/]/u)[0] ?? '';
  return base === '' || base === '—' ? '' : ` ${base}`;
}

function verbOf(direction: Direction | null, tense: 'past' | 'order'): string {
  if (tense === 'past') {
    return direction === 'long' ? 'Bought' : direction === 'short' ? 'Sold' : 'Traded';
  }
  return direction === 'long' ? 'buy' : direction === 'short' ? 'sell' : 'order';
}

/** `Kuru spot` / `Perpl perps` — where the order went, and what kind of book it is. */
function venueKind(venue: string): string {
  const kind = VENUE_KIND[venue];
  return kind === undefined ? venueLabel(venue) : `${venueLabel(venue)} ${kind}`;
}

const VENUE_KIND: Record<string, string> = { kuru: 'spot', perpl: 'perps' };
