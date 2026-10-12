/**
 * What this device knows about its own Perpl positions before the server does
 * (SEN-202).
 *
 * `/portfolio` serves a linked account's Perpl section from a 30 s cache
 * (SEN-151, `USER_PERPL_TTL_MS`), and the last good read for up to 120 s more
 * when Perpl fails. The phone's own orders never pass through the server, so
 * right after an open the server still says "no position", and right after a
 * close it still lists the closed one — the page offered "Close" again and
 * the retry failed with "no open Perpl position", because Perpl was right.
 *
 * So after each order the screen records what Perpl itself now says (read
 * over the trading socket, `perpReconcile.ts`), and every reader of the
 * portfolio sees that instead of the server's older answer, until the
 * server's own read agrees or the entry expires. One entry per market: the
 * latest action wins.
 *
 * Pure functions plus a tiny module-scope store; `usePortfolio.ts` binds it.
 */
import type { Position } from '@sente/venues';

import type { PositionDto } from '../agents/api.ts';
import type { Portfolio } from '../trade/types.ts';

export type PositionLike = Pick<PositionDto, 'side' | 'size' | 'entryPrice'>;

export type OverlayEntry =
  /** Perpl lists this position now (an open, an add, a partial close). */
  | { kind: 'position'; symbol: string; at: number; position: PositionDto }
  /** Perpl lists no position on the market now (a close). */
  | { kind: 'gone'; symbol: string; at: number; before: PositionLike | null }
  /**
   * An order filled but Perpl's position has not shown it yet. The server's
   * answer stands, flagged as updating, until it differs from `before`.
   */
  | { kind: 'pending'; symbol: string; at: number; before: PositionLike | null };

/**
 * How long an entry outlives the server's lag: its 30 s cache plus the 120 s
 * it may serve a stale read, plus a poll. After that the server is the truth
 * again, whatever it says.
 */
export const OVERLAY_TTL_MS = 160_000;

/**
 * The same position across reads: side, size and entry match (mark and P&L
 * move, these do not). Decimal strings compare by value. Absent equals absent.
 */
export function samePosition(
  a: PositionLike | null | undefined,
  b: PositionLike | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.side === b.side &&
    Number(a.size) === Number(b.size) &&
    Number(a.entryPrice) === Number(b.entryPrice)
  );
}

/** A venue `Position` as `/portfolio` sends it (`positionDto` in the API). */
export function toPositionDto(position: Position): PositionDto {
  return {
    symbol: position.symbol,
    side: position.side,
    size: position.size,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    liquidationPriceEst: position.liquidationPrice ?? null,
    leverage: position.leverage,
    margin: position.margin,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl ?? null,
    fundingPaid: position.fundingPaid ?? null,
    quote: 'AUSD',
    updatedAt: position.updatedAt,
  };
}

export type Overlaid = {
  positions: PositionDto[];
  /** Markets with an order whose effect Perpl has not shown yet: say "Updating…", not "none". */
  pending: string[];
  /** Entries the server's read now agrees with (or that expired): drop them. */
  settled: string[];
};

/** The server's positions with this device's newer knowledge applied. */
export function overlayPositions(
  server: readonly PositionDto[],
  entries: readonly OverlayEntry[],
  now: number,
): Overlaid {
  let positions = [...server];
  const pending: string[] = [];
  const settled: string[] = [];
  for (const entry of entries) {
    const { symbol } = entry;
    const theirs = positions.find((p) => p.symbol === symbol) ?? null;
    const others = positions.filter((p) => p.symbol !== symbol);
    if (now - entry.at > OVERLAY_TTL_MS) {
      settled.push(symbol);
      continue;
    }
    switch (entry.kind) {
      case 'position':
        // The server caught up: its copy has the live mark, so it wins.
        if (samePosition(theirs, entry.position)) settled.push(symbol);
        else positions = [...others, entry.position];
        break;
      case 'gone':
        if (theirs === null) settled.push(symbol);
        // Still the position that closed: the server's read predates the close.
        else if (entry.before === null || samePosition(theirs, entry.before)) positions = others;
        // A different position: opened since, somewhere else. The server is newer.
        else settled.push(symbol);
        break;
      case 'pending':
        if (!samePosition(theirs, entry.before)) settled.push(symbol);
        else pending.push(symbol);
        break;
    }
  }
  return { positions, pending, settled };
}

/**
 * The portfolio with the overlay applied to its Perpl section. Only a section
 * that listed positions (`ok`, read through the key) is touched: a failed or
 * unlinked one says nothing about positions to correct.
 */
export function overlayPortfolio(
  portfolio: Portfolio,
  entries: readonly OverlayEntry[],
  now: number,
): { portfolio: Portfolio; pending: string[]; settled: string[] } {
  const perpl = portfolio.perpl;
  if (entries.length === 0 || !perpl.ok || perpl.status !== 'ok') {
    return { portfolio, pending: [], settled: [] };
  }
  const { positions, pending, settled } = overlayPositions(perpl.positions ?? [], entries, now);
  return { portfolio: { ...portfolio, perpl: { ...perpl, positions } }, pending, settled };
}

/** The portfolio's position on a perp market; `null` for none or when its Perpl section is unread. */
export function perplPositionOn(portfolio: Portfolio | null, symbol: string): PositionDto | null {
  const perpl = portfolio?.perpl;
  if (!perpl?.ok || perpl.status !== 'ok') return null;
  return perpl.positions?.find((p) => p.symbol === symbol) ?? null;
}

// ---------------------------------------------------------------------------
// The store: one per app, so the ticket, the position page and the Portfolio
// tab all see the same entries.

type Listener = () => void;

let entries: readonly OverlayEntry[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Records what Perpl now says about `entry.symbol`, replacing any earlier entry for it. */
export function recordPerpl(entry: OverlayEntry): void {
  entries = [...entries.filter((e) => e.symbol !== entry.symbol), entry];
  emit();
}

/** Drops the entries for these markets (the server caught up). */
export function settlePerpl(symbols: readonly string[]): void {
  if (symbols.length === 0) return;
  const next = entries.filter((e) => !symbols.includes(e.symbol));
  if (next.length === entries.length) return;
  entries = next;
  emit();
}

export function perplOverlay(): readonly OverlayEntry[] {
  return entries;
}

export function subscribePerplOverlay(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
