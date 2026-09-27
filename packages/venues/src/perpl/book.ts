/**
 * Keeping an L2 book current from `mt:16` updates (SEN-62, plan B-T1).
 *
 * The market-data socket sends one `mt:15` snapshot per subscribe and then
 * only `mt:16` updates. An update carries the CHANGED levels only, in the
 * snapshot's shape: a level replaces the one at the same price, and `o: 0`
 * removes it. Probed live on testnet 2026-09-28; docs/perpl.md has the evidence.
 */
import type { PerplL2Book, PerplL2Level } from './wire.ts';

/** Applies one `mt:16` update to a book and returns the new book; neither input is mutated. */
export function applyL2BookUpdate(book: PerplL2Book, update: PerplL2Book): PerplL2Book {
  return {
    ...book,
    // The update's header is the newer one: callers read `at`/`sn` for freshness.
    at: update.at,
    ...(update.sn !== undefined ? { sn: update.sn } : {}),
    bid: merge(book.bid, update.bid ?? [], (a, b) => b - a),
    ask: merge(book.ask, update.ask ?? [], (a, b) => a - b),
  };
}

function merge(
  levels: readonly PerplL2Level[],
  changes: readonly PerplL2Level[],
  order: (a: number, b: number) => number,
): PerplL2Level[] {
  if (changes.length === 0) return [...levels];
  const byPrice = new Map(levels.map((level) => [level.p, level]));
  for (const change of changes) {
    if (change.o === 0) byPrice.delete(change.p);
    else byPrice.set(change.p, change);
  }
  return [...byPrice.values()].sort((a, b) => order(a.p, b.p));
}
