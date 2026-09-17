/**
 * Perpl order/fill semantics — the parts that are pure enough to unit test.
 *
 * WHY THIS FILE EXISTS
 *
 * Perpl's fill events are not self-describing:
 *   `TakerOrderFilledV2` has no perpId and no accountId at all; the only place
 *   the aggressor's identity and intent appear is the `OrderRequestV2` the
 *   transaction opened with. `MakerOrderFilledV2` carries perpId+accountId, but
 *   not *which side* the maker was on — that is the opposite of the taker it
 *   filled.
 *
 * So both are resolved by log order inside the transaction, which is stable and
 * was confirmed on chain rather than assumed. Real shape of tx
 * 0xd58c92adeb7a58603a8ccb14599477de289bb1f03148039328a018fc40aad070
 * (block 63311165, Monad testnet):
 *
 *   logIndex 68  OrderRequestV2        accountId 2, perpId 16, orderType 1
 *   logIndex 69  PositionDecreased     accountId 1 (maker leg)
 *   logIndex 70  MakerOrderFilledV2    accountId 1, pricePNS 768109, lotLNS 588
 *   logIndex 71  PositionDecreased     accountId 2 (taker leg)
 *   logIndex 72  TakerOrderFilledV2    lotLNS 588, feeCNS 94847, prices 768109
 *   logIndex 73  OrderBatchCompleted
 *
 * An `OrderRequestV2` therefore always precedes the fills it produced and maker
 * fills precede the taker fill. Envio runs handlers in log order within a batch
 * and serves `getWhere` from its in-memory table, so the later handler does read
 * the earlier handler's uncommitted row — that is the mechanism this relies on.
 */

/**
 * Perpl's on-chain order type, `OrderDescEnum`.
 *
 * **Zero-based.** The deployed contract encodes `OpenLong` as 0 — the numbers
 * are not published, so they were read off the transaction above (a `1` that
 * reduced a long position, i.e. a sell) and then confirmed against the
 * authority in PerplFoundation/dex-sdk, `crates/sdk/src/types/order.rs`:
 *
 *     0 => OrderType::OpenLong
 *     1 => OrderType::OpenShort
 *     2 => OrderType::CloseLong
 *     3 => OrderType::CloseShort
 *
 * An off-by-one here flips every Perpl trade's side and therefore its PnL sign,
 * which is why it is pinned by a test rather than only a comment.
 */
export const PERPL_ORDER_TYPE = {
  openLong: 0,
  openShort: 1,
  closeLong: 2,
  closeShort: 3,
} as const;

export type PerplSide = 'BUY' | 'SELL';

/**
 * The aggressor's side, from the SDK's own `OrderType::side()`:
 * `OpenLong | CloseShort => Bid`, `OpenShort | CloseLong => Ask`.
 *
 * `OpenLong`/`OpenShort` are not "open only" — Perpl uses them to decrease,
 * close or invert a position too (every quote above is Bid or Ask). Only the
 * `*Close*` pair are reduce-only.
 *
 * Returns `undefined` for anything outside 0-3, so a value the contract should
 * never emit is reported and skipped rather than silently taped as a sell.
 */
export function perplSide(orderType: number): PerplSide | undefined {
  switch (orderType) {
    case PERPL_ORDER_TYPE.openLong:
    case PERPL_ORDER_TYPE.closeShort:
      return 'BUY';
    case PERPL_ORDER_TYPE.openShort:
    case PERPL_ORDER_TYPE.closeLong:
      return 'SELL';
    default:
      return undefined;
  }
}

export type PerplOrderIntent = {
  readonly txHash: string;
  readonly logIndex: number;
  readonly perpId: bigint;
  readonly accountId: bigint;
  readonly orderType: number;
};

/**
 * The request that produced a fill: the latest intent in the same transaction
 * with a lower logIndex. A transaction carrying several forwarded requests (a
 * keeper batch) resolves each fill to its nearest preceding one.
 */
export function selectOrderIntent(
  intents: readonly PerplOrderIntent[],
  fillLogIndex: number,
): PerplOrderIntent | undefined {
  let best: PerplOrderIntent | undefined;
  for (const intent of intents) {
    if (intent.logIndex >= fillLogIndex) continue;
    if (best === undefined || intent.logIndex > best.logIndex) best = intent;
  }
  return best;
}

export type PerplMakerFillRef = {
  readonly logIndex: number;
  readonly perpId: bigint;
  readonly accountId: bigint;
  readonly feeCns: bigint;
};

/**
 * The maker standing behind a taker fill: the *first* maker fill in the tx.
 * A multi-maker sweep emits one `MakerOrderFilledV2` per resting order but only
 * one `TakerOrderFilledV2` for the aggregate, so the taker's `Trade` row is
 * attributed to the first maker — market volume is counted once per match, not
 * once per leg. Every maker still gets its own `AccountMarketStats` row from
 * its own fill event.
 */
export function selectFirstMakerFill(
  fills: readonly PerplMakerFillRef[],
  takerLogIndex: number,
): PerplMakerFillRef | undefined {
  let best: PerplMakerFillRef | undefined;
  for (const fill of fills) {
    if (fill.logIndex >= takerLogIndex) continue;
    if (best === undefined || fill.logIndex < best.logIndex) best = fill;
  }
  return best;
}

/**
 * The taker fill's price, in PNS.
 *
 * `TakerOrderFilledV2` carries three price fields and none is documented, so
 * this too was settled on chain rather than by name. In the transaction above
 * all three read 768109, and the maker's `MakerOrderFilledV2.pricePNS` read
 * 768109 — the same match, to the digit. The `OrderRequestV2`'s own `pricePNS`
 * read 768060, i.e. it is the slippage bound and NOT the fill price.
 *
 * `pnlPricePNS` is preferred because it is the price PnL was *settled* at for
 * this fill, i.e. the average match price. `entryPricePNS` is the resulting
 * *position* entry price, which blends with an existing basis when a fill adds
 * to a position — right as a position field, wrong for a trade tape. The zero
 * fallbacks mean a missing field can never silently price a trade at 0.
 */
export function perplFillPricePns(fill: {
  readonly pnlPricePns: bigint;
  readonly collatPricePns: bigint;
  readonly entryPricePns: bigint;
}): bigint {
  if (fill.pnlPricePns !== 0n) return fill.pnlPricePns;
  if (fill.collatPricePns !== 0n) return fill.collatPricePns;
  return fill.entryPricePns;
}
