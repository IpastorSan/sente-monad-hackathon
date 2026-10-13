/**
 * What a perp open or close from this device actually did, decided against
 * Perpl's own positions rather than against the order's confirmation alone
 * (SEN-202).
 *
 * The order's settle event can be lost after the order executed — a socket
 * that drops, a confirmation that times out, an exchange event that lands
 * after the watcher gave up — and the server's portfolio lags Perpl by up to
 * its 30 s cache. So after every order the screen re-reads the account's
 * positions over the trading socket and asks this module what happened.
 * "Didn't go through" is said only when Perpl's position proves it; an
 * outcome Perpl cannot confirm yet is `pending`, never a failure.
 *
 * Pure: no React, no socket. `perplTrader.ts` does the reads.
 */
import type { Order, Position } from '@sente/venues';
import { PerplNoPositionError, PerplOrderRejectedError } from '@sente/venues/perpl';

import {
  samePosition,
  toPositionDto,
  type OverlayEntry,
  type PositionLike,
} from '../portfolio/perplOverlay.ts';
import { PerplTraderError } from './perplTrader.ts';
import { displayAmount } from '../ui/displayAmount.ts';

/**
 * One read of the account's position on the market: the position, `null`
 * when Perpl lists none, `undefined` when the read itself failed.
 */
export type PositionRead = Position | null | undefined;

/**
 * Nothing can have moved, so there is nothing to re-read: refused before
 * sending, or Perpl had no position to close.
 */
export function nothingSent(error: unknown): boolean {
  return error instanceof PerplTraderError || error instanceof PerplNoPositionError;
}

/**
 * The order may have executed without its confirmation reaching us: not
 * refused before sending, and not refused or failed by Perpl.
 */
export function outcomeUnknown(error: unknown): boolean {
  return !nothingSent(error) && !(error instanceof PerplOrderRejectedError);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CloseVerdict =
  /** Perpl holds no position any more. `order` carries fill and tx when its settle event arrived. */
  | { kind: 'closed'; order: Order | null }
  /** The close found nothing to close: an earlier close already did it. */
  | { kind: 'already-closed' }
  /** Part filled; `remaining` is Perpl's position now, when read. */
  | { kind: 'partial'; order: Order | null; remaining: Position | null }
  /** The order settled with nothing filled (the book was outside the bound). Still open. */
  | { kind: 'unfilled' }
  /** Perpl refused or failed it, and its position shows it never moved. */
  | { kind: 'failed'; message: string }
  /** Not known yet: re-read Perpl before saying anything. */
  | { kind: 'pending'; message: string };

/**
 * The close's outcome from what the order said (`order`, or the `error` it
 * threw instead) and what Perpl's position on the market reads now (`after`).
 * `size` is the position the screen asked to close.
 */
export function closeVerdict(input: {
  size: string;
  order?: Order;
  error?: unknown;
  after: PositionRead;
}): CloseVerdict {
  const { size, order, error, after } = input;
  if (error instanceof PerplNoPositionError) return { kind: 'already-closed' };
  if (error !== undefined && nothingSent(error)) {
    return { kind: 'failed', message: messageOf(error) };
  }

  if (order) {
    const filled = Number(order.filledSize);
    // Perpl lists nothing: closed, whatever the order event said.
    if (after === null) return { kind: 'closed', order };
    if (!(filled > 0)) return { kind: 'unfilled' };
    // Filled in full: trust the order over a position read that lags it.
    if (filled >= Number(order.size)) return { kind: 'closed', order };
    return { kind: 'partial', order, remaining: after ?? null };
  }

  // The order threw after it may have been sent: Perpl's position decides.
  if (after === null) return { kind: 'closed', order: null };
  if (after !== undefined && Number(after.size) < Number(size)) {
    return { kind: 'partial', order: null, remaining: after };
  }
  // Perpl failed the order outright and the position never moved.
  if (after !== undefined && error instanceof PerplOrderRejectedError) {
    return { kind: 'failed', message: messageOf(error) };
  }
  return {
    kind: 'pending',
    message: error === undefined ? 'Perpl has not shown the close yet.' : messageOf(error),
  };
}

export type OpenVerdict =
  /** Perpl lists the position the order made (or grew). */
  | { kind: 'open'; position: Position }
  /** Perpl's position has not moved yet. */
  | { kind: 'pending' };

/**
 * Whether Perpl now shows what an open (or an add) did: any position on the
 * market that differs from `before`, the one the screen held before ordering
 * (`null` for none).
 */
export function openVerdict(before: PositionLike | null, after: PositionRead): OpenVerdict {
  if (after && !samePosition(after, before)) return { kind: 'open', position: after };
  return { kind: 'pending' };
}

/**
 * What the perp ticket says after an open threw (SEN-203). Only a refusal
 * (nothing sent, or Perpl rejected it) is "didn't go through"; an order that
 * may have been sent is `landed` when Perpl's position shows it and otherwise
 * `unconfirmed` — checked again, never invited to be placed twice. A limit is
 * read back the same way (a fill shows as a position), but a limit that rests
 * moves no position, so for it `unconfirmed` also points at its open orders.
 */
export type OpenAfterError =
  | { kind: 'failed' }
  | { kind: 'read-back' }
  | { kind: 'landed'; position: Position }
  | { kind: 'unconfirmed' };

/**
 * `sent`: whether the order could have left this device (a trader was open).
 * `verdict`: Perpl's position read back, once there is one.
 */
export function openAfterError(input: {
  error: unknown;
  sent: boolean;
  verdict?: OpenVerdict;
}): OpenAfterError {
  const { error, sent, verdict } = input;
  if (!sent || !outcomeUnknown(error)) return { kind: 'failed' };
  if (verdict === undefined) return { kind: 'read-back' };
  return verdict.kind === 'open'
    ? { kind: 'landed', position: verdict.position }
    : { kind: 'unconfirmed' };
}

/**
 * Re-reads Perpl's position on a market until `decide` stops answering
 * `pending`, waiting `delaysMs[i]` before read `i`. Returns the last verdict,
 * so a caller still holding `pending` after the last read says "checking",
 * not "failed". A read that throws counts as `undefined` (unknown).
 */
export async function reconcile<V extends { kind: string }>(options: {
  read: () => Promise<Position | null>;
  decide: (after: PositionRead) => V;
  delaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<V> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let verdict = options.decide(undefined);
  for (const delay of options.delaysMs) {
    if (delay > 0) await sleep(delay);
    let after: PositionRead;
    try {
      after = await options.read();
    } catch {
      after = undefined;
    }
    verdict = options.decide(after);
    if (verdict.kind !== 'pending') return verdict;
  }
  return verdict;
}

/** Backoff for re-reading Perpl after an order: about 11 s in all, five sign-ins at most. */
export const RECONCILE_DELAYS_MS: readonly number[] = [0, 1_000, 2_000, 3_000, 5_000];

/** The account's position on `symbol` from a positions read, `null` for none. */
export function positionOn(positions: readonly Position[], symbol: string): Position | null {
  return positions.find((p) => p.symbol === symbol) ?? null;
}

/**
 * What the portfolio should show for the market until the server catches up
 * (`perplOverlay.ts`): `null` when the close changed nothing.
 */
export function closeOverlay(
  verdict: CloseVerdict,
  symbol: string,
  before: PositionLike,
  at: number,
): OverlayEntry | null {
  switch (verdict.kind) {
    case 'closed':
    case 'already-closed':
      return { kind: 'gone', symbol, at, before };
    case 'partial':
      return verdict.remaining
        ? { kind: 'position', symbol, at, position: toPositionDto(verdict.remaining) }
        : { kind: 'pending', symbol, at, before };
    case 'pending':
      return { kind: 'pending', symbol, at, before };
    case 'unfilled':
    case 'failed':
      return null;
  }
}

/** The same for an open (or an add) that filled: Perpl's new position, or "updating". */
export function openOverlay(
  verdict: OpenVerdict,
  symbol: string,
  before: PositionLike | null,
  at: number,
): OverlayEntry {
  return verdict.kind === 'open'
    ? { kind: 'position', symbol, at, position: toPositionDto(verdict.position) }
    : { kind: 'pending', symbol, at, before };
}

/** What the close sheet says for a verdict. `done`: nothing is left to do but leave. */
export type CloseNotice = {
  tone: 'ok' | 'error' | 'info';
  title: string;
  detail: string;
  txHash: string | undefined;
  done: boolean;
};

function fillText(order: Order | null, base: string): string | null {
  if (!order || !(Number(order.filledSize) > 0)) return null;
  const at = order.averageFillPrice ? ` at ${order.averageFillPrice}` : '';
  return `${displayAmount(order.filledSize)} ${base}${at}`;
}

export function describeClose(verdict: CloseVerdict, symbol: string, base: string): CloseNotice {
  switch (verdict.kind) {
    case 'closed': {
      const filled = fillText(verdict.order, base);
      return {
        tone: 'ok',
        title: 'Position closed',
        detail: filled
          ? `${filled}. Perpl shows no open position on ${symbol} now.`
          : `Perpl shows no open position on ${symbol} now. The fill’s own confirmation didn’t reach this device; Portfolio lists it with your fills.`,
        txHash: verdict.order?.txHash,
        done: true,
      };
    }
    case 'already-closed':
      return {
        tone: 'ok',
        title: 'Already closed',
        detail: `Perpl has no open position on ${symbol}: your earlier close went through. Nothing moved this time.`,
        txHash: undefined,
        done: true,
      };
    case 'partial': {
      const filled = fillText(verdict.order, base);
      return {
        tone: 'ok',
        title: 'Partly closed',
        detail: `${filled ? `${filled} closed.` : 'Part of it closed.'} ${
          verdict.remaining
            ? `${displayAmount(verdict.remaining.size)} ${base} is still open.`
            : 'The rest is still open.'
        }`,
        txHash: verdict.order?.txHash,
        done: false,
      };
    }
    case 'unfilled':
      return {
        tone: 'info',
        title: 'Nothing filled',
        detail: 'The book couldn’t fill it within 1% of the mark. The position is still open.',
        txHash: undefined,
        done: false,
      };
    case 'failed':
      return {
        tone: 'error',
        title: 'The close didn’t go through',
        detail: `${verdict.message} Your position is still open.`,
        txHash: undefined,
        done: false,
      };
    case 'pending':
      return {
        tone: 'info',
        title: 'Still checking with Perpl',
        detail:
          'The close was sent, but Perpl hasn’t shown it yet. Check again in a moment before closing again.',
        txHash: undefined,
        done: false,
      };
  }
}
