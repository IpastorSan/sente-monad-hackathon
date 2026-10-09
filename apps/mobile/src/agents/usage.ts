/**
 * What the agents list and the agent screen say about an agent at a glance
 * (SEN-58): how much of each mandate limit it has used, how long the mandate
 * has left, whether it is trading, which balance is its headline, and its last
 * move as one line.
 *
 * Only REAL data goes in. The API's summary (SEN-56) reports the largest order
 * an agent has sent and when its mandate took effect, and nothing else a limit
 * could be measured against — so a gauge exists for order size and for time,
 * and every other limit is drawn as its cap alone. A gauge for a limit nothing
 * measures would be a made-up number on the one screen that has to be trusted.
 *
 * Money is compared as exact decimals, never through a float: a float only
 * ever becomes the 0..1 width of a bar, which no one reads as a figure.
 *
 * Plain node, no React Native, so `usage.test.ts` runs without a device.
 */
import { formatFixedAtoms, normalizeDecimal } from './amounts.ts';
import type { AgentMandate, AgentSummary, WireAgentEvent } from './api.ts';
import {
  depositAmount,
  SIGNED_PNL_PLACES,
  signedPnl,
  toLedgerEntries,
  venueLabel,
} from './ledger.ts';
import { stoneFor, type LedgerStone } from './ledgerView.ts';
import { formatNotional } from './mandate.ts';
import { BALANCE_PLACES } from '../ui/format.ts';
import { signedFigure } from '../ui/money.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Exact decimals

/**
 * Two non-negative decimal strings compared exactly: -1, 0 or 1. `null` when
 * either is not a plain decimal, so a malformed figure is never ordered by
 * accident.
 */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 | null {
  const left = normalizeDecimal(a);
  const right = normalizeDecimal(b);
  if (left === null || right === null) return null;
  const [lw = '0', lf = ''] = left.split('.');
  const [rw = '0', rf = ''] = right.split('.');
  const places = Math.max(lf.length, rf.length);
  const l = BigInt(lw + lf.padEnd(places, '0'));
  const r = BigInt(rw + rf.padEnd(places, '0'));
  return l < r ? -1 : l > r ? 1 : 0;
}

/**
 * Which way a signed P&L string points, AT THE PLACES IT IS SHOWN: `null` for
 * no figure or one that rounds to zero. SEN-136: judged on the exact figure,
 * `-0.001` was painted berry beside a label reading `0.00`; so a caller showing
 * `pnlLabel` passes its 2 places, and the default is `signedPnl`'s.
 */
export function pnlTone(
  pnl: string | null | undefined,
  places = SIGNED_PNL_PLACES,
): 'up' | 'down' | null {
  return signedFigure(pnl, places)?.tone ?? null;
}

// ---------------------------------------------------------------------------
// Gauges

export type GaugeReading = {
  /** 0..1, clamped: the bar's width. */
  used: number;
  /** What the gauge prints on its right. */
  value: string;
  /** Past the cap — possible after an amend lowered it. The caller says so. */
  over: boolean;
};

/**
 * The fraction of `cap` that `used` is, clamped to 0..1. A zero cap is full
 * as soon as anything is used against it, and empty otherwise.
 */
export function usedFraction(used: string | null, cap: string): number {
  if (used === null) return 0;
  const order = compareDecimals(used, '0');
  if (order === null || order === 0) return 0;
  const vsCap = compareDecimals(used, cap);
  if (vsCap === null) return 0;
  if (vsCap >= 0) return 1;
  // Below the cap, exactly — only now is a float allowed, for the bar.
  const fraction = Number(normalizeDecimal(used)) / Number(normalizeDecimal(cap));
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
}

/**
 * The largest order the agent has sent against `maxOrderNotional`.
 *
 * With no summary at all (an API that predates SEN-56) or no order yet, the
 * gauge shows the cap with nothing used, and `measured` tells the caller which
 * of the two it is so the caption can say so honestly.
 */
export function orderUsage(
  summary: AgentSummary | undefined,
  mandate: AgentMandate,
): GaugeReading & { measured: boolean } {
  const cap = mandate.maxOrderNotional;
  const largest = summary?.largestOrderNotional ?? null;
  const shown = largest === null ? '0' : largest;
  return {
    used: usedFraction(largest, cap),
    value: `${formatNotional(normalizeDecimal(shown) ?? shown)} / ${formatNotional(cap)}`,
    over: largest !== null && compareDecimals(largest, cap) === 1,
    measured: summary !== undefined,
  };
}

/**
 * `5d 14h`, `3h 20m`, `12m`, or `under a minute`. Two units at most: a
 * countdown is read for its size, not to the second.
 */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'under a minute';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * How much of the mandate's lifetime has passed: from when the current
 * mandate took effect (`since`, epoch ms — the summary's `mandateSince`, or the
 * hire) to `expiresAt` (unix SECONDS, as the mandate carries it).
 */
export function expiryUsage(since: number, expiresAt: number, now: number): GaugeReading {
  const end = expiresAt * 1000;
  if (now >= end) return { used: 1, value: 'expired', over: true };
  const span = end - since;
  const used = span > 0 ? Math.min(1, Math.max(0, (now - since) / span)) : 0;
  return { used, value: `in ${formatDuration(end - now)}`, over: false };
}

// ---------------------------------------------------------------------------
// Status

/**
 * How recent the last event must be for an agent to read as "Trading" — the
 * breathing pill, which means "running right now", so it needs a recent event
 * to back it. The runner wakes an agent every few minutes; past this window it
 * is waiting for a setup rather than in the middle of one. One rule for every
 * screen that shows the pill (SEN-57/SEN-58 had a window each).
 */
export const TRADING_WINDOW_MS = 15 * MINUTE;

/**
 * "Trading" rather than "Watching". The summary's `lastEvent` already leaves
 * out run summaries, so a runner that woke up and decided nothing does not
 * count as activity.
 */
export function isTrading(
  summary: Pick<AgentSummary, 'lastEvent'> | undefined,
  now: number,
): boolean {
  const at = summary?.lastEvent?.at;
  return at !== undefined && now - at <= TRADING_WINDOW_MS && now - at >= -MINUTE;
}

/** `now`, `4m`, `3h`, `2d`: how long ago, for a line that is already about time. */
export function relativeAge(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return 'now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
  return `${Math.floor(ago / DAY)}d`;
}

/** `Kuru spot`, `Perpl perps · 2×`, or both: what the agent trades, for a caption. */
export function venuesCaption(mandate: AgentMandate): string {
  const parts: string[] = [];
  if (mandate.venues.includes('kuru')) parts.push('Kuru spot');
  if (mandate.venues.includes('perpl')) parts.push(`Perpl perps · ${mandate.perpl.maxLeverage}×`);
  return parts.join(' · ') || 'No venue';
}

// ---------------------------------------------------------------------------
// Balances

export type Holding = { symbol: string; atoms: bigint; decimals: number };

/** Stablecoins: the only balances that can be compared with each other by size. */
const STABLES = ['USDC', 'AUSD'];

/**
 * The balance an agent is summed up by. The larger stablecoin (both are 6
 * decimals, and compared as atoms scaled to a common precision anyway), else
 * the first other token it holds; `fallback` names the one to show at zero.
 *
 * Native MON is never the headline: it is the agent's gas, and it cannot be
 * returned (no rule lets an agent move native MON), so "412 MON in its wallet"
 * would describe money the user cannot act on.
 */
export function mainHolding(holdings: readonly Holding[], fallback: string): Holding | null {
  const scaled = (h: Holding) => h.atoms * 10n ** BigInt(Math.max(0, 18 - h.decimals));
  const stables = holdings.filter((h) => STABLES.includes(h.symbol) && h.atoms > 0n);
  if (stables.length > 0) {
    return stables.reduce((best, h) => (scaled(h) > scaled(best) ? h : best));
  }
  const other = holdings.find((h) => h.symbol !== 'MON' && h.atoms > 0n);
  return other ?? holdings.find((h) => h.symbol === fallback) ?? null;
}

/** Whether anything returnable is left: any token but native MON. */
export function holdsReturnable(holdings: readonly Holding[]): boolean {
  return holdings.some((h) => h.symbol !== 'MON' && h.atoms > 0n);
}

/** A holding as a balance figure, at the app's shared precision (`BALANCE_PLACES`). */
export function formatHolding(holding: Holding): string {
  return formatFixedAtoms(holding.atoms, holding.decimals, {
    places: BALANCE_PLACES[holding.symbol] ?? 2,
  });
}

// ---------------------------------------------------------------------------
// The last move

/** The Ledger's stone, so a move is placed the same everywhere (`ledgerView.stoneFor`). */
export type MoveStone = LedgerStone;

export type Move = { stone: MoveStone; line: string; at: number };

/**
 * One event as the stone and the one line the list and the agent screen show.
 * Built on the Ledger's own mapping (`toLedgerEntries`), so a move reads the
 * same here as in the Ledger; `null` for an event the Ledger does not show.
 */
export function describeMove(event: WireAgentEvent): Move | null {
  const [entry] = toLedgerEntries([event]);
  if (!entry) return null;
  const at = entry.at;
  switch (entry.kind) {
    case 'thesis':
      return { stone: 'thesis', line: `Wrote a thesis on ${entry.market}`, at };
    case 'trade': {
      if (!entry.filled) {
        return { stone: 'trade', line: `An order on ${entry.market} didn’t land`, at };
      }
      const verb =
        entry.direction === 'long' ? 'Bought' : entry.direction === 'short' ? 'Sold' : 'Traded';
      const venue = entry.venue ? ` on ${venueLabel(entry.venue)}` : '';
      const size = entry.size === '—' ? '' : `${entry.size} `;
      return { stone: 'trade', line: `${verb} ${size}${entry.market}${venue}`, at };
    }
    case 'refusal':
      // Held, not failed: a refusal is the mandate working (never berry).
      return {
        stone: 'refusal',
        line:
          entry.layer === 'enclave'
            ? 'The enclave refused to sign an order'
            : 'Held an order outside the mandate',
        at,
      };
    case 'verdict': {
      const market = entry.market ?? 'a position';
      const stone = stoneFor(entry);
      if (entry.pnl === null) return { stone, line: `Closed ${market}`, at };
      return { stone, line: `Closed ${market} at ${signedPnl(entry.pnl)}`, at };
    }
    case 'deposit': {
      const amount = depositAmount(entry).replace(/^\+/, '');
      return {
        stone: 'deposit',
        line: `Received ${amount}${entry.asset ? ` ${entry.asset}` : ''}`,
        at,
      };
    }
    case 'account':
      return { stone: stoneFor(entry), line: entry.message, at };
  }
}
