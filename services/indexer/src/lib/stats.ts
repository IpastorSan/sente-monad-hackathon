/**
 * Aggregate math for the leaderboard: signed moving-average cost basis with
 * exact BigInt quote arithmetic, plus entity-id helpers shared by handlers.
 *
 * Position convention: `baseRaw` is signed base in book/LNS units (+ long,
 * − short); `costRaw` carries the same sign and holds the quote atoms paid
 * for the open position, so avgCost = costRaw / baseRaw in atoms/unit.
 *
 * A trade that adds to the position extends the basis with its quote atoms
 * and realises nothing. A trade that reduces closes `closed = min(|pos|,
 * |trade|)` at the stored average; the quote atoms attributed to the closed
 * slice are the trade's atoms × closed / |trade| (floored):
 *
 *   long closed:   realized = atomsClosed − (costRaw × closed) / baseRaw
 *   short closed:  realized = (|costRaw| × closed)/|baseRaw| − atomsClosed
 *
 * A flip consumes the entire old basis and reopens the leftover at the trade
 * price. All divisions truncate toward zero — the same floor Kuru applies —
 * so on a closed position the last trade absorbs any rounding dust of a few
 * atoms. `wins`/`losses` count reducing trades by the sign of `realizedRaw`.
 */

export type PositionState = {
  /** signed base in raw book/LNS units */
  readonly baseRaw: bigint;
  /** signed quote atoms carried by the open position */
  readonly costRaw: bigint;
};

export type FillResult = PositionState & {
  /** realised PnL in quote atoms (negative on losses) */
  readonly realizedRaw: bigint;
  /** true when the fill reduced or flipped the position — an outcome to count */
  readonly reduces: boolean;
};

/**
 * Apply one fill of `tradeBaseRaw` signed base units costing
 * `tradeQuoteAtoms` (non-negative quote atoms for |tradeBaseRaw| units at
 * the trade price, computed by the venue-specific helper below).
 */
export function applyFill(
  pos: PositionState,
  tradeBaseRaw: bigint,
  tradeQuoteAtoms: bigint,
): FillResult {
  const b = pos.baseRaw;
  const c = pos.costRaw;
  const t = tradeBaseRaw;
  const atoms = tradeQuoteAtoms < 0n ? 0n : tradeQuoteAtoms;
  if (t === 0n) {
    return { baseRaw: b, costRaw: c, realizedRaw: 0n, reduces: false };
  }
  if (b === 0n || b > 0n === t > 0n) {
    return {
      baseRaw: b + t,
      costRaw: c + (t > 0n ? atoms : -atoms),
      realizedRaw: 0n,
      reduces: false,
    };
  }
  const long = b > 0n;
  const absPos = long ? b : -b;
  const absTrade = long ? -t : t;
  const closed = absTrade < absPos ? absTrade : absPos;
  const atomsClosed = (atoms * closed) / absTrade;
  const basisClosed = (c * closed) / b; // magnitude (positive) for both signs
  const realizedRaw = long
    ? atomsClosed - basisClosed // proceeds − basis paid
    : basisClosed - atomsClosed; // basis received − buyback paid
  const leftover = b + t;
  const costRaw =
    leftover === 0n
      ? 0n
      : leftover > 0n === b > 0n
        ? (c * leftover) / b
      : (atoms * leftover) / absTrade;
  return { baseRaw: leftover, costRaw, realizedRaw, reduces: true };
}

/** Kuru quote atoms for a fill: price(book) × size(book) × 10^q / (pp × sp). */
export function kuruQuoteAtoms(
  priceRaw: bigint,
  sizeRaw: bigint,
  pricePrecision: bigint,
  sizePrecision: bigint,
  quoteDecimals: number,
): bigint {
  return (
    (priceRaw * sizeRaw * 10n ** BigInt(quoteDecimals)) / (pricePrecision * sizePrecision)
  );
}

/** Perpl CNS for a fill: pricePNS × lotLNS × 10^collatDecimals / (10^pd × 10^sd). */
export function perplQuoteAtoms(
  pricePns: bigint,
  lotLns: bigint,
  priceDecimals: number,
  sizeDecimals: number,
  collateralDecimals: number,
): bigint {
  const scale = 10n ** BigInt(priceDecimals + sizeDecimals);
  return (pricePns * lotLns * 10n ** BigInt(collateralDecimals)) / scale;
}

/** Entity-id helpers: everything lowercase, venue-prefixed. */
export const kuruAccountId = (id: bigint): string => `kuru-${id}`;
export const perplAccountId = (id: bigint): string => `perpl-${id}`;
export const statsId = (accountId: string, marketId: string): string =>
  `${accountId}-${marketId}`;
export const balanceId = (accountId: string, token: string): string =>
  `${accountId}-${token.toLowerCase()}`;
export const dayId = (marketId: string, day: number): string => `${marketId}-${day}`;
export const tradeId = (chainId: number, block: number, logIndex: number, record: number): string =>
  `${chainId}-${block}-${logIndex}-${record}`;

/** yyyymmdd integer for MarketDay ids, from a seconds timestamp. */
export function yyyymmdd(timestampSeconds: number): number {
  const d = new Date(timestampSeconds * 1000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}