/**
 * Phone Kuru market facts (SEN-90, plan M-T8).
 *
 * The phone's own reading of a Kuru market: the worst price an IOC may take
 * and the most a trade may deposit. The policy verifier (M-T10) compares the
 * server's prepared calls against THESE numbers, never the server's, so a
 * buggy or compromised API can refuse a trade but cannot widen its slippage
 * or pull more into AccountCore than the order needs — see
 * docs/design/trading/plan-trading.md, Architecture §6 "Slippage".
 *
 * The pure half repeats the adapter's rounding (`kuruSlippageBound`,
 * `quoteReserveAtoms` in `@sente/venues/kuru`) rather than calling it, because
 * those take a `Decimal` and return one, and the verifier compares book units.
 * `kuruMarket.test.ts` pins both halves to the adapter on shared cases, so the
 * phone and the server cannot drift apart silently.
 */
import type { KuruMarketConfig, KuruMarketParams } from '@sente/venues/kuru';
import { KURU_TESTNET_CONTRACTS } from '@sente/venues/kuru';
import type { Address, PublicClient } from 'viem';

type Side = 'buy' | 'sell';

/** Basis points per 1: `slippageBps = 50` is 0.5%. */
const BPS = 10_000n;
/** Kuru fee rates are parts per ten million (`PPS_DENOMINATOR` in the adapter). */
const PPS = 10_000_000n;
/** `bestBidAsk()` reports an empty bid side as uint32 max and an empty ask side as 0. */
const EMPTY_BID = 2n ** 32n - 1n;
const EMPTY_ASK = 0n;

export class KuruMarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KuruMarketError';
  }
}

/**
 * The limit price, in book price units, of an IOC that may move `slippageBps`
 * away from `bestUnits` (the best ask for a buy, the best bid for a sell).
 *
 * Buys floor to the tick (never pay more than allowed), sells ceil (never sell
 * for less) — the adapter's rule. In bps rather than the adapter's WAD
 * fraction because that is what the user sets; `bps * 1e14` is the same WAD,
 * so the arithmetic lands on the same atom.
 */
export function worstPriceUnits(
  bestUnits: bigint,
  slippageBps: number,
  tick: bigint,
  side: Side,
): bigint {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0) {
    throw new KuruMarketError(`slippage ${slippageBps} bps is not a whole, non-negative number`);
  }
  if (bestUnits <= 0n) throw new KuruMarketError('best price must be positive');
  if (tick <= 0n) throw new KuruMarketError('tick size must be positive');
  const bps = BigInt(slippageBps);

  if (side === 'buy') {
    const bound = (bestUnits * (BPS + bps)) / BPS;
    return bound - (bound % tick);
  }
  // A 100% sell bound would accept any price at all.
  if (bps >= BPS) throw new KuruMarketError('slippage must be below 100% for a sell');
  const raw = (bestUnits * (BPS - bps) + BPS - 1n) / BPS;
  return raw % tick === 0n ? raw : raw + tick - (raw % tick);
}

/** The part of a `NativeOrder` that decides what it locks. Book units. */
export type KuruReserveOrder = {
  readonly side: Side;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly tif: 'gtc' | 'ioc' | 'fok';
};

/**
 * The most a trade placing `order` may deposit into AccountCore, in atoms of
 * the funding token: quote for a buy, base for a sell (plan M-T12).
 *
 * A buy locks notional plus fee headroom, rounded up: this is
 * `quoteReserveAtoms` with the fee the planner uses — maker for a resting
 * order (Kuru locks maker headroom, docs/kuru.md "10.004 USDC"), taker for an
 * IOC/FOK that only takes. A sell locks exactly its base quantity, rounded up
 * to whole atoms; Kuru takes its fee out of the quote proceeds, so no base
 * headroom is needed. `quoteReserveAtoms` has no sell counterpart, hence the
 * base branch lives only here.
 *
 * `builderFeePps` is Sente's builder fee (SEN-184), the pinned rate, added to
 * the buy's fee headroom exactly as the planner adds it; 0 without one.
 *
 * The verifier caps the deposit at this, not at the shortfall against the
 * free balance: a read the server also makes may be a block apart, and a
 * deposit up to the full reserve can only park the user's own funds in the
 * user's own Kuru account.
 */
export function depositCapAtoms(
  order: KuruReserveOrder,
  params: Pick<
    KuruMarketParams,
    'pricePrecision' | 'sizePrecision' | 'makerFeePps' | 'takerFeePps'
  >,
  decimals: { readonly quote: number; readonly base: number },
  builderFeePps: number = 0,
): bigint {
  if (order.quantity <= 0n || order.price <= 0n) {
    throw new KuruMarketError('order price and quantity must be positive');
  }
  if (order.side === 'sell') {
    const numerator = order.quantity * 10n ** BigInt(decimals.base);
    return ceilDiv(numerator, params.sizePrecision);
  }
  const venueFeePps = order.tif === 'gtc' ? params.makerFeePps : params.takerFeePps;
  const feePps = venueFeePps + BigInt(builderFeePps);
  const numerator = order.price * order.quantity * 10n ** BigInt(decimals.quote) * (PPS + feePps);
  return ceilDiv(numerator, params.pricePrecision * params.sizePrecision * PPS);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

// ---------------------------------------------------------------------------
// Chain reads.
//
// Hand-written fragments, not the SDK's full ABIs, for the same reason as
// `kuruLegs.ts`: the phone names exactly what it calls. The test pins each to
// the SDK so a typo cannot drift.

export const KURU_MARKET_READ_ABI = [
  {
    type: 'function',
    name: 'getMarketParams',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '', type: 'uint32' },
      { name: '', type: 'uint96' },
      { name: '', type: 'uint32' },
      { name: '', type: 'uint96' },
      { name: '', type: 'uint96' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'bestBidAsk',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'bid', type: 'uint32' },
      { name: 'ask', type: 'uint32' },
    ],
  },
] as const;

export const KURU_BALANCE_READ_ABI = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export type KuruReadClient = Pick<PublicClient, 'readContract'>;

/** What the phone knows about one market, from its own reads. Book price units. */
export type MarketFacts = {
  readonly params: KuruMarketParams;
  /** `null` when the bid side is empty. */
  readonly bestBid: bigint | null;
  /** `null` when the ask side is empty. */
  readonly bestAsk: bigint | null;
};

/**
 * `getMarketParams` and `bestBidAsk` for `market`, read in parallel. The
 * empty-side sentinels become `null` so no caller can mistake uint32 max for a
 * bid.
 *
 * Refuses a market whose on-chain precisions differ from the config, as the
 * adapter does: every price the user was shown was decoded with the config's.
 */
export async function readMarketFacts(
  client: KuruReadClient,
  market: KuruMarketConfig,
): Promise<MarketFacts> {
  const [rawParams, [bid, ask]] = await Promise.all([
    client.readContract({
      address: market.address,
      abi: KURU_MARKET_READ_ABI,
      functionName: 'getMarketParams',
    }),
    client.readContract({
      address: market.address,
      abi: KURU_MARKET_READ_ABI,
      functionName: 'bestBidAsk',
    }),
  ]);
  const [pricePrecision, sizePrecision, tickSize, minQuote, maxQuote, takerFee, makerFee] =
    rawParams;
  const params: KuruMarketParams = {
    pricePrecision: BigInt(pricePrecision),
    sizePrecision: BigInt(sizePrecision),
    tickSize: BigInt(tickSize),
    minQuoteNotional: minQuote,
    maxQuoteNotional: maxQuote,
    takerFeePps: takerFee,
    makerFeePps: makerFee,
  };
  if (
    params.pricePrecision !== market.pricePrecision ||
    params.sizePrecision !== market.sizePrecision
  ) {
    throw new KuruMarketError(`${market.symbol}: on-chain units differ from config; refusing it`);
  }
  const bestBid = BigInt(bid);
  const bestAsk = BigInt(ask);
  return {
    params,
    bestBid: bestBid === EMPTY_BID ? null : bestBid,
    bestAsk: bestAsk === EMPTY_ASK ? null : bestAsk,
  };
}

/**
 * `wallet`'s FREE AccountCore balance of `token`, in atoms — what a deposit
 * shortfall is measured against. Reserved balance (resting orders) is not
 * included, because it cannot fund a new order.
 */
export async function readKuruFree(
  client: KuruReadClient,
  wallet: Address,
  token: Address,
  accountCore: Address = KURU_TESTNET_CONTRACTS.accountCore,
): Promise<bigint> {
  return client.readContract({
    address: accountCore,
    abi: KURU_BALANCE_READ_ABI,
    functionName: 'getBalance',
    args: [wallet, token],
  });
}
