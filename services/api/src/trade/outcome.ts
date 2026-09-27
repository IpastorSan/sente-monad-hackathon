/**
 * What a Kuru place actually did, and where the user's money is afterwards
 * (SEN-97, plan M-T15).
 *
 * `batch` returns nothing, so the only record of a fill is the OrderBook's
 * packed events in the place's receipt. They are read from the USER
 * OPERATION's own logs (`bundler.receipt(hash).logs`), never the bundle
 * transaction's: that transaction can carry other accounts' operations against
 * the same market (CLAUDE.md gotcha 8, and `decodeOrderOutcome`'s contract).
 *
 * One decoder, two callers: the step executor's `onStepLanded` hook, for a
 * place that landed while it waited, and `TradeService.reconcile`, for one the
 * executor gave up on as `unknown` and a later read found landed. Both go
 * through {@link TradeOutcomes.placeResult}, so a late-settled trade reports
 * the same result an on-time one would.
 *
 * The decoding itself is the venue package's — `decodeOrderOutcome` for the
 * events, `toPlacedOrder` for the fill, average price and fee arithmetic the
 * agents' orders already use — so the phone and the agents' portfolio never
 * disagree about the same receipt. What is added here is only the mapping onto
 * the wire's `KuruPlaceResult`, which says "partially filled, rest cancelled"
 * where the shared `Order` says `cancelled`.
 */

import {
  decodeOrderOutcome,
  formatOrderId,
  fromUnits,
  precisionDecimals,
  toPlacedOrder,
  type KuruLog,
} from '@sente/venues/kuru';
import type { Address } from 'viem';

import type {
  KuruPlaceContext,
  KuruPlaceResult,
  StepStatus,
  Trade,
  TradeFunds,
  TradeStep,
} from './trade-store';

/** Every allowed Kuru market is quoted in USDC, and Kuru charges fees in the quote. */
const FEE_ASSET = 'USDC';

/** A step whose user operation runs the place leg: the place itself, or a packed batch. */
export function carriesPlace(step: Pick<TradeStep, 'kind'>): boolean {
  return step.kind === 'place' || step.kind === 'batch';
}

/**
 * The result of a place whose user operation was INCLUDED, from that
 * operation's logs. `accountId` is the wallet's Kuru account id
 * (`userRegistry(wallet)`), read after the operation landed: a first deposit
 * registers it in the same trade.
 *
 * A market order is an IOC at the phone's worst price, so it can take part of
 * the book and discard the rest: that is `partially_filled` with
 * `unfilledCancelled`, not the shared `Order`'s `cancelled`. A remainder that
 * rests on the book is `partially_filled` with an `orderId` and no
 * `unfilledCancelled`.
 */
export function placeResult(
  logs: readonly KuruLog[],
  accountId: bigint,
  place: KuruPlaceContext,
): KuruPlaceResult {
  const outcome = decodeOrderOutcome(logs, place.market, accountId);
  const order = toPlacedOrder({
    symbol: place.symbol,
    side: place.side,
    type: place.orderType,
    timeInForce: place.timeInForce,
    quantity: place.quantity,
    price: place.price,
    params: place.params,
    outcome,
    // Unused here: the result's `orderId` comes from the rested record below,
    // and `toPlacedOrder` only falls back to this hash for its own `id`.
    executionHash: '',
    transactionHash: '',
    observedAt: 0,
    quoteDecimals: place.quoteDecimals,
    feeAsset: FEE_ASSET,
  });

  const sizeDecimals = precisionDecimals(place.params.sizePrecision);
  const priceDecimals = precisionDecimals(place.params.pricePrecision);
  const filled = outcome.fills.reduce((sum, fill) => sum + fill.size, 0n);
  const remainder = place.quantity > filled ? place.quantity - filled : 0n;
  // One order was placed, so at most one of this account's orders rested.
  const rested = outcome.rested.at(-1);

  const base = {
    requestedSize: order.size,
    filledSize: order.filledSize,
    ...(order.averageFillPrice !== undefined ? { avgPrice: order.averageFillPrice } : {}),
    fee: order.fee ?? '0',
    feeAsset: FEE_ASSET,
    fills: outcome.fills.map((fill) => ({
      price: fromUnits(fill.price, priceDecimals),
      size: fromUnits(fill.size, sizeDecimals),
      tradeId: fill.tradeId.toString(),
    })),
    ...(rested ? { orderId: formatOrderId(rested) } : {}),
  } as const;
  const discarded = { unfilledCancelled: fromUnits(remainder, sizeDecimals) };

  switch (order.status) {
    case 'open':
      return { ...base, status: 'resting' };
    case 'partially_filled':
      return { ...base, status: 'partially_filled' };
    case 'filled':
      return { ...base, status: 'filled' };
    case 'cancelled': // an IOC that took some and discarded the rest
      return { ...base, status: 'partially_filled', ...discarded };
    case 'expired': // an IOC that took nothing
      return { ...base, status: 'cancelled', ...discarded };
    case 'rejected': // a crossing POST_ONLY, skipped rather than reverted
    default:
      return { ...base, status: 'rejected' };
  }
}

/** A place whose user operation reverted: nothing reached the book. */
export function revertedPlaceResult(place: KuruPlaceContext): KuruPlaceResult {
  return {
    status: 'rejected',
    requestedSize: fromUnits(place.quantity, precisionDecimals(place.params.sizePrecision)),
    filledSize: '0',
    fee: '0',
    feeAsset: FEE_ASSET,
    fills: [],
  };
}

const IN_FLIGHT: ReadonlySet<StepStatus> = new Set([
  'awaiting_signature',
  'queued',
  'submitted',
  'unknown',
]);

/**
 * Where the money this trade deposited is now, when the trade did not simply
 * do what was asked — "the USDC you deposited stays in your Kuru account"
 * (plan §2, "Batching"). Undefined when there is nothing honest to add:
 *
 * - no deposit, or not a place: nothing of the user's moved on our account;
 * - any step still in flight or `unknown`: the deposit or the order may yet
 *   land, and a statement now could be wrong in either direction;
 * - the order filled or rests: the `result` says what the deposit became.
 *
 * An `approve` alone moves nothing, so "not deposited" means "still in the
 * wallet". A packed `batch` is atomic (gotcha 8's corollary): if it reverted,
 * the deposit inside it reverted too.
 */
export function fundsAfter(trade: Trade): TradeFunds | undefined {
  const place = trade.place;
  if (!place || place.funding.deposit === 0n) return undefined;
  if (trade.steps.some((step) => IN_FLIGHT.has(step.status))) return undefined;

  const amount = fromUnits(place.funding.deposit, place.funding.decimals);
  const at = (where: 'wallet' | 'kuru'): TradeFunds => [
    { where, symbol: place.funding.symbol, amount },
  ];
  const landed = (kinds: readonly string[]) =>
    trade.steps.some((step) => kinds.includes(step.kind) && step.status === 'included');

  if (!landed(['deposit', 'batch'])) return at('wallet');
  if (!landed(['place', 'batch'])) return at('kuru');
  // The order ran but took nothing and left nothing resting: the deposit is
  // still free in the Kuru account.
  const status = trade.result?.status;
  if (status === 'cancelled' || status === 'rejected') return at('kuru');
  return undefined;
}

export interface TradeOutcomesDeps {
  /** The wallet's Kuru account id: AccountCore `userRegistry(wallet)`; 0 if none. */
  readonly accountId: (wallet: Address) => Promise<bigint>;
}

/** The one place a landed step's receipt becomes a `KuruPlaceResult`. */
export class TradeOutcomes {
  readonly #deps: TradeOutcomesDeps;

  constructor(deps: TradeOutcomesDeps) {
    this.#deps = deps;
  }

  /**
   * The result a landed step gives its trade, or undefined when the step is
   * not a place (an approve, a deposit, a cancel, a withdraw) or the trade has
   * no place context. `logs` must be that step's own user-operation logs.
   *
   * Rejects when the wallet has no Kuru account after an included place:
   * decoding against account 0 would report "nothing filled" for an order
   * that did run, and no result is more honest than a wrong one.
   */
  async placeResult(
    trade: Trade,
    step: TradeStep,
    logs: readonly KuruLog[],
  ): Promise<KuruPlaceResult | undefined> {
    const place = trade.place;
    if (!place || !carriesPlace(step)) return undefined;
    if (step.status === 'reverted') return revertedPlaceResult(place);
    if (step.status !== 'included') return undefined;
    const accountId = await this.#deps.accountId(trade.address);
    if (accountId === 0n) {
      throw new Error(`${trade.address} has no Kuru account after its place was included`);
    }
    return placeResult(logs, accountId, place);
  }
}
