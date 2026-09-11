/**
 * Kuru Spot V2 behind Sente's `Venue` interface.
 *
 * READS come from wherever is authoritative for the question:
 *   - chain (AccountCore / OrderBook views) for anything a signature is about
 *     to depend on — market params, balances, the live book behind a quote,
 *     the account id, what a slot holds right before it is cancelled;
 *   - Exchange Gateway for the displayed book and the account's open orders;
 *   - Data Source for the market catalog, candles and order history.
 *
 * WRITES are call lists handed to a `KuruSubmitter`. The adapter holds no key
 * and does no batching of its own: it produces calls, the submitter lands them
 * as one UserOperation, and the adapter decodes what the OrderBook reported.
 * Why direct OrderBook calls and not Kuru's Relay: see `orders.ts`.
 */
import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import { isAddressEqual, type Address, type Hex, type PublicClient } from 'viem';

import type {
  Balance,
  CancelRequest,
  Decimal,
  Depth,
  DepthQuery,
  Kline,
  KlineQuery,
  LimitOrderRequest,
  Market,
  MarketOrderRequest,
  MarketSymbol,
  Order,
  OrderRequestBase,
  OrderType,
  Quote,
  QuoteRequest,
  Side,
  TimeInForce,
} from '../types.ts';
import type { Venue } from '../venue.ts';
import { createKuruApi, type KuruApi, type KuruApiConfig } from './api.ts';
import {
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  type KuruMarketConfig,
  type KuruToken,
} from './constants.ts';
import {
  bucketStart,
  KLINE_INTERVAL_MS,
  KLINE_SOURCE,
  simulateQuote,
  toDepth,
  toKlines,
  toMarket,
  toOpenOrder,
  toPlacedOrder,
  type BookLevel,
} from './mapping.ts';
import {
  cancelOrderCall,
  decodeOrderOutcome,
  depositCalls,
  encodeNativeOrder,
  formatOrderId,
  KuruOrderError,
  parseOrderId,
  placeOrderCall,
  toClientOrderId,
  withdrawCall,
  type KuruCall,
  type KuruLog,
  type KuruMarketParams,
  type KuruOrderRef,
} from './orders.ts';
import { fromUnits, precisionDecimals, toUnits } from './units.ts';

/**
 * What a submitter reports back once a call list has landed.
 *
 * For a smart account `success` MUST be the UserOperation receipt's `success`,
 * and `logs` that UserOperation's own logs. The carrying transaction reports
 * `status: 0x1` even when the UserOperation inside it reverted (CLAUDE.md
 * gotcha 8); a submitter that forwarded the transaction status would let the
 * adapter tell a user an order landed when it did not.
 */
export type KuruExecution = {
  /** UserOperation hash for a smart account; transaction hash for an EOA. */
  readonly hash: Hex;
  readonly transactionHash: Hex;
  readonly success: boolean;
  readonly logs: readonly KuruLog[];
};

/**
 * Lands a call list for ONE account, atomically. For the Kernel account that
 * is one ERC-7579 batch through `apps/mobile/src/wallet/batch.ts`, whose
 * revert-on-failure exec type is what makes deposit-then-place all-or-nothing.
 */
export type KuruSubmitter = {
  /** The account the calls execute as — the AccountCore root. */
  readonly address: Address;
  submit(calls: readonly KuruCall[]): Promise<KuruExecution>;
};

export type KuruVenueConfig = {
  readonly publicClient: PublicClient;
  /** Without one the adapter is read-only and every write throws. */
  readonly submitter?: KuruSubmitter;
  /** Account whose balances and orders are read. Defaults to the submitter's. */
  readonly account?: Address;
  readonly api?: KuruApiConfig;
  readonly markets?: readonly KuruMarketConfig[];
  readonly accountCore?: Address;
};

/** The call list was included on chain but reverted. Nothing it asked for happened. */
export class KuruExecutionError extends Error {
  readonly hash: Hex;

  constructor(hash: Hex) {
    super(`Kuru execution ${hash} was included but reverted; nothing was placed or cancelled`);
    this.name = 'KuruExecutionError';
    this.hash = hash;
  }
}

/** Levels per side read for a quote. */
const QUOTE_LEVELS = 100n;
const GATEWAY_MAX_LEVELS = 200;
const DEFAULT_KLINE_LIMIT = 500;
/** The Data Source's hard cap on candles per request. */
const MAX_CANDLES = 5000;
/** `bestBidAsk()` reports an empty bid side as uint32 max and an empty ask side as 0. */
const EMPTY_BID = 2n ** 32n - 1n;
const WAD = 10n ** 18n;

type PreparedOrder = {
  readonly market: KuruMarketConfig;
  readonly params: KuruMarketParams;
  readonly side: Side;
  readonly timeInForce: TimeInForce;
  readonly quantity: bigint;
  readonly clientOrderId: string | undefined;
  readonly call: KuruCall;
};

export class KuruVenue implements Venue {
  readonly id = 'kuru';
  readonly name = 'Kuru';

  readonly #client: PublicClient;
  readonly #submitter: KuruSubmitter | undefined;
  readonly #account: Address | undefined;
  readonly #api: KuruApi;
  readonly #accountCore: Address;
  readonly #markets: readonly KuruMarketConfig[];
  readonly #params = new Map<Address, Promise<KuruMarketParams>>();
  #accountId: bigint | undefined;

  constructor(config: KuruVenueConfig) {
    this.#client = config.publicClient;
    this.#submitter = config.submitter;
    this.#account = config.account ?? config.submitter?.address;
    this.#api = createKuruApi(config.api);
    this.#accountCore = config.accountCore ?? KURU_TESTNET_CONTRACTS.accountCore;
    this.#markets = config.markets ?? KURU_TESTNET_MARKETS;
  }

  // -------------------------------------------------------------------------
  // Kuru-specific extensions. Additive; the shared `Venue` is untouched.

  market(symbol: MarketSymbol): KuruMarketConfig {
    const market = this.#markets.find((candidate) => candidate.symbol === symbol);
    if (!market) {
      throw new KuruOrderError(`Kuru does not list ${symbol}`);
    }
    return market;
  }

  /** Live `getMarketParams()`, cached per market once read. */
  marketParams(symbol: MarketSymbol): Promise<KuruMarketParams> {
    const market = this.market(symbol);
    let params = this.#params.get(market.address);
    if (!params) {
      params = this.#readMarketParams(market);
      this.#params.set(market.address, params);
      params.catch(() => this.#params.delete(market.address));
    }
    return params;
  }

  /** This account's AccountCore id; `0n` until its first deposit registers it. */
  async accountId(): Promise<bigint> {
    if (this.#accountId !== undefined) return this.#accountId;
    const id = BigInt(
      await this.#client.readContract({
        address: this.#accountCore,
        abi: kuruAbi.accountCoreAbi,
        functionName: 'userRegistry',
        args: [this.#requireAccount()],
      }),
    );
    // An assigned id never changes, so only a real one is worth caching.
    if (id !== 0n) this.#accountId = id;
    return id;
  }

  /**
   * Calls that move `amount` of `asset` into this account's AccountCore
   * balance. Prepend them to `limitOrderCalls` to fund and place as one
   * atomic Kernel batch.
   */
  depositCalls(asset: string, amount: Decimal): KuruCall[] {
    const token = this.#token(asset);
    return depositCalls(this.#accountCore, token, toUnits(amount, token.decimals, 'amount'));
  }

  /** A limit order as calls, validated and encoded but not submitted. */
  async limitOrderCalls(request: LimitOrderRequest): Promise<KuruCall[]> {
    return [(await this.#prepareLimit(request)).call];
  }

  deposit(asset: string, amount: Decimal): Promise<KuruExecution> {
    return this.#submit(this.depositCalls(asset, amount));
  }

  /** The call that moves `amount` of free `asset` from this account back to its own address. */
  withdrawCalls(asset: string, amount: Decimal): KuruCall[] {
    const token = this.#token(asset);
    return [withdrawCall(this.#accountCore, token, toUnits(amount, token.decimals, 'amount'))];
  }

  withdraw(asset: string, amount: Decimal): Promise<KuruExecution> {
    return this.#submit(this.withdrawCalls(asset, amount));
  }

  // -------------------------------------------------------------------------
  // Venue — reads

  async getMarkets(): Promise<Market[]> {
    const listed = await this.#api.markets();
    return listed.flatMap((api) => {
      const market = this.#markets.find((m) =>
        isAddressEqual(m.address, api.marketAddress as Address),
      );
      return market ? [toMarket(api, market)] : [];
    });
  }

  async getDepth({ symbol, limit = 20 }: DepthQuery): Promise<Depth> {
    const market = this.market(symbol);
    const levels = Math.min(Math.max(Math.trunc(limit), 1), GATEWAY_MAX_LEVELS);
    return toDepth(await this.#api.depth(market.venueSymbol, levels), market, levels, Date.now());
  }

  async getKlines(query: KlineQuery): Promise<Kline[]> {
    const market = this.market(query.symbol);
    const width = KLINE_INTERVAL_MS[query.interval];
    const source = KLINE_SOURCE[query.interval];
    const perKline = width / KLINE_INTERVAL_MS[source];
    const limit = query.limit ?? DEFAULT_KLINE_LIMIT;
    const end = query.endTime ?? Date.now(); // exclusive
    // Start on a bucket boundary so the first aggregated kline is complete.
    const start = query.startTime ?? bucketStart(end - limit * width, query.interval);

    const candles = await this.#api.candles(market.address, {
      interval: source,
      from: Math.floor(start / 1000),
      to: Math.floor((end - 1) / 1000),
      countback: Math.min(MAX_CANDLES, Math.ceil(limit * perKline) + perKline),
    });
    const klines = toKlines(candles, market, query.interval).filter(
      (kline) => kline.openTime >= start && kline.openTime < end,
    );
    return klines.slice(-limit);
  }

  async quote({ symbol, side, size }: QuoteRequest): Promise<Quote> {
    const market = this.market(symbol);
    const [params, [bidPrices, bidSizes, askPrices, askSizes]] = await Promise.all([
      this.marketParams(symbol),
      this.#client.readContract({
        address: market.address,
        abi: kuruAbi.spotOrderBookAbi,
        functionName: 'getL2Book',
        args: [QUOTE_LEVELS],
      }),
    ]);
    const levels = (prices: readonly number[], sizes: readonly bigint[]): BookLevel[] =>
      prices
        .map((price, i) => ({ price: BigInt(price), size: sizes[i] ?? 0n }))
        .filter((level) => level.size > 0n);
    return simulateQuote({
      symbol,
      side,
      size,
      params,
      quoteDecimals: market.quote.decimals,
      bids: levels(bidPrices, bidSizes),
      asks: levels(askPrices, askSizes),
      observedAt: Date.now(),
    });
  }

  async getOpenOrders(symbol?: MarketSymbol): Promise<Order[]> {
    const accountId = await this.accountId();
    if (accountId === 0n) return [];
    const wanted = symbol === undefined ? this.#markets : [this.market(symbol)];
    const observedAt = Date.now();
    const orders = await this.#api.userOrders(accountId);
    return orders.flatMap((api) => {
      const market = wanted.find((m) => isAddressEqual(m.address, api.marketAddress as Address));
      return market ? [toOpenOrder(api, market, observedAt)] : [];
    });
  }

  /**
   * AccountCore balances: `available` is free balance, `locked` is reserved by
   * resting orders. Passive-liquidity inventory is held by the OrderBooks, not
   * here, and is not included.
   */
  async getBalances(): Promise<Balance[]> {
    const user = this.#requireAccount();
    return Promise.all(
      this.#tokens().map(async (token) => {
        const [free, reserved] = await Promise.all([
          this.#client.readContract({
            address: this.#accountCore,
            abi: kuruAbi.accountCoreAbi,
            functionName: 'getBalance',
            args: [user, token.address],
          }),
          this.#client.readContract({
            address: this.#accountCore,
            abi: kuruAbi.accountCoreAbi,
            functionName: 'getSpotReservedBalance',
            args: [user, token.address],
          }),
        ]);
        return {
          asset: token.symbol,
          available: fromUnits(free, token.decimals),
          locked: fromUnits(reserved, token.decimals),
          total: fromUnits(free + reserved, token.decimals),
        };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Venue — writes

  async placeLimit(request: LimitOrderRequest): Promise<Order> {
    return this.#place(await this.#prepareLimit(request), 'limit', request.price);
  }

  /**
   * Kuru has no native market order: this is an IOC limit order at the
   * slippage bound. Refuses to submit without one — `slippageLimitPrice`, or
   * `maxSlippage` applied to the live best price.
   */
  async placeMarket(request: MarketOrderRequest): Promise<Order> {
    rejectReduceOnly(request);
    const market = this.market(request.symbol);
    const params = await this.marketParams(request.symbol);
    const bound =
      request.slippageLimitPrice ??
      (request.maxSlippage === undefined
        ? undefined
        : await this.#slippageBound(market, params, request.side, request.maxSlippage));
    if (bound === undefined) {
      throw new KuruOrderError(
        'refusing an unbounded market order: set slippageLimitPrice or maxSlippage',
      );
    }
    const prepared = this.#prepare(market, params, request, bound, 'IOC');
    return this.#place(prepared, 'market', undefined);
  }

  /**
   * Cancels by slot, but only after confirming on chain that the slot still
   * holds this order id — slots are reused, and a stale id must not cancel a
   * newer order. An order that is already gone is a no-op that reports its
   * terminal state from Kuru's order history.
   *
   * Between that read and inclusion only this account can refill the slot,
   * so the window is limited to concurrent writes by the same account.
   */
  async cancel(request: CancelRequest): Promise<Order> {
    const market = this.market(request.symbol);
    const ref = parseOrderId(request.orderId);
    const accountId = await this.accountId();
    if (accountId === 0n) {
      throw new KuruOrderError('this account has never traded on Kuru');
    }

    const live = await this.#client.readContract({
      address: market.address,
      abi: kuruAbi.spotOrderBookAbi,
      functionName: 'getOrderId',
      args: [Number(accountId), ref.slotIdx],
    });
    if (BigInt(live) !== ref.orderId) {
      return this.#terminalOrder(market, accountId, ref);
    }

    const execution = await this.#submit([cancelOrderCall(market.address, ref.slotIdx)]);
    const outcome = decodeOrderOutcome(execution.logs, market.address, accountId);
    const removed = outcome.removed.find(
      (record) => record.slotIdx === ref.slotIdx && record.orderId === ref.orderId,
    );
    if (!removed) {
      // Filled after the read; the cancel found an empty slot.
      return this.#terminalOrder(market, accountId, ref);
    }

    const params = await this.marketParams(market.symbol);
    const sd = precisionDecimals(params.sizePrecision);
    const created = (await this.#history(accountId, market, ref)).created;
    const originalSize = created?.size ? BigInt(created.size) : removed.size;
    const now = Date.now();
    return {
      id: request.orderId,
      clientOrderId: created?.clientOrderId ?? undefined,
      symbol: market.symbol,
      side: removed.isBuy ? 'buy' : 'sell',
      type: 'limit',
      status: 'cancelled',
      price: fromUnits(removed.price, precisionDecimals(params.pricePrecision)),
      size: fromUnits(originalSize, sd),
      filledSize: fromUnits(originalSize - removed.size, sd),
      createdAt: created?.blockTimestamp ?? now,
      updatedAt: now,
      txHash: execution.transactionHash,
    };
  }

  // -------------------------------------------------------------------------

  async #readMarketParams(market: KuruMarketConfig): Promise<KuruMarketParams> {
    const [pricePrecision, sizePrecision, tickSize, minQuote, maxQuote, takerFeePps, makerFeePps] =
      await this.#client.readContract({
        address: market.address,
        abi: kuruAbi.spotOrderBookAbi,
        functionName: 'getMarketParams',
      });
    const params: KuruMarketParams = {
      pricePrecision: BigInt(pricePrecision),
      sizePrecision: BigInt(sizePrecision),
      tickSize: BigInt(tickSize),
      minQuoteNotional: BigInt(minQuote),
      maxQuoteNotional: BigInt(maxQuote),
      takerFeePps: BigInt(takerFeePps),
      makerFeePps: BigInt(makerFeePps),
    };
    // The read APIs are decoded with the configured precisions. If the chain
    // disagrees, every displayed price is wrong, so refuse the market outright.
    if (
      params.pricePrecision !== market.pricePrecision ||
      params.sizePrecision !== market.sizePrecision
    ) {
      throw new KuruOrderError(`${market.symbol}: on-chain units differ from config; refusing it`);
    }
    return params;
  }

  async #prepareLimit(request: LimitOrderRequest): Promise<PreparedOrder> {
    rejectReduceOnly(request);
    if (request.expiresAt !== undefined) {
      throw new KuruOrderError('Kuru has no good-till-date orders; expiresAt is not supported');
    }
    const market = this.market(request.symbol);
    const params = await this.marketParams(request.symbol);
    return this.#prepare(market, params, request, request.price, request.timeInForce ?? 'GTC');
  }

  #prepare(
    market: KuruMarketConfig,
    params: KuruMarketParams,
    request: OrderRequestBase,
    price: Decimal,
    timeInForce: TimeInForce,
  ): PreparedOrder {
    const order = encodeNativeOrder(
      { side: request.side, price, size: request.size, timeInForce },
      params,
      market.quote.decimals,
    );
    const clientOrderId = request.clientOrderId;
    return {
      market,
      params,
      side: request.side,
      timeInForce,
      quantity: order.quantity,
      clientOrderId,
      call: placeOrderCall(
        market.address,
        order,
        clientOrderId === undefined ? undefined : toClientOrderId(clientOrderId),
      ),
    };
  }

  async #place(
    prepared: PreparedOrder,
    type: OrderType,
    price: Decimal | undefined,
  ): Promise<Order> {
    const execution = await this.#submit([prepared.call]);
    // Read after submitting: a first order can arrive in the same batch as the
    // deposit that registers the account.
    const accountId = await this.accountId();
    return toPlacedOrder({
      symbol: prepared.market.symbol,
      side: prepared.side,
      type,
      timeInForce: prepared.timeInForce,
      quantity: prepared.quantity,
      price,
      clientOrderId: prepared.clientOrderId,
      params: prepared.params,
      outcome: decodeOrderOutcome(execution.logs, prepared.market.address, accountId),
      executionHash: execution.hash,
      transactionHash: execution.transactionHash,
      observedAt: Date.now(),
    });
  }

  async #submit(calls: readonly KuruCall[]): Promise<KuruExecution> {
    if (!this.#submitter) {
      throw new KuruOrderError('this KuruVenue is read-only: no submitter configured');
    }
    const execution = await this.#submitter.submit(calls);
    if (!execution.success) {
      throw new KuruExecutionError(execution.hash);
    }
    return execution;
  }

  /** The worst acceptable price: best opposite price moved `maxSlippage` against us, onto a tick. */
  async #slippageBound(
    market: KuruMarketConfig,
    params: KuruMarketParams,
    side: Side,
    maxSlippage: Decimal,
  ): Promise<Decimal> {
    const slippage = toUnits(maxSlippage, 18, 'maxSlippage');
    const [bid, ask] = await this.#client.readContract({
      address: market.address,
      abi: kuruAbi.spotOrderBookAbi,
      functionName: 'bestBidAsk',
    });
    const pd = precisionDecimals(params.pricePrecision);
    const tick = params.tickSize;

    if (side === 'buy') {
      const best = BigInt(ask);
      if (best === 0n) throw new KuruOrderError(`${market.symbol} has no asks`);
      const bound = (best * (WAD + slippage)) / WAD;
      return fromUnits(bound - (bound % tick), pd); // floor: never pay more than allowed
    }
    const best = BigInt(bid);
    if (best === EMPTY_BID) throw new KuruOrderError(`${market.symbol} has no bids`);
    if (slippage >= WAD) throw new KuruOrderError('maxSlippage must be below 1 for a sell');
    const raw = (best * (WAD - slippage) + WAD - 1n) / WAD;
    return fromUnits(raw % tick === 0n ? raw : raw + tick - (raw % tick), pd); // ceil: never sell for less
  }

  async #history(accountId: bigint, market: KuruMarketConfig, ref: KuruOrderRef) {
    const events = await this.#api.orderEvents(accountId, market.address).catch(() => []);
    const of = (kind: string) =>
      events.find((event) => event.eventKind === kind && BigInt(event.orderId) === ref.orderId);
    return { created: of('created'), cancelled: of('cancelled') };
  }

  /** A cancel that found nothing to cancel: report how the order actually ended. */
  async #terminalOrder(
    market: KuruMarketConfig,
    accountId: bigint,
    ref: KuruOrderRef,
  ): Promise<Order> {
    const { created, cancelled } = await this.#history(accountId, market, ref);
    if (!created) {
      throw new KuruOrderError(
        `order ${formatOrderId(ref)} is not resting and has no finalized history yet`,
      );
    }
    const params = await this.marketParams(market.symbol);
    const sd = precisionDecimals(params.sizePrecision);
    const size = BigInt(created.size ?? '0');
    const unfilled = cancelled?.size ? BigInt(cancelled.size) : 0n;
    return {
      id: formatOrderId(ref),
      clientOrderId: created.clientOrderId ?? undefined,
      symbol: market.symbol,
      side: created.isBuy ? 'buy' : 'sell',
      type: 'limit',
      // Kuru's history has no fill event: created, not cancelled, not resting = filled.
      status: cancelled ? 'cancelled' : 'filled',
      price: fromUnits(BigInt(created.price), precisionDecimals(params.pricePrecision)),
      size: fromUnits(size, sd),
      filledSize: fromUnits(size - unfilled, sd),
      createdAt: created.blockTimestamp,
      updatedAt: (cancelled ?? created).blockTimestamp,
    };
  }

  #requireAccount(): Address {
    if (!this.#account) {
      throw new KuruOrderError('no account configured: pass `account` or a `submitter`');
    }
    return this.#account;
  }

  #tokens(): KuruToken[] {
    const tokens = new Map<string, KuruToken>();
    for (const market of this.#markets) {
      tokens.set(market.base.address.toLowerCase(), market.base);
      tokens.set(market.quote.address.toLowerCase(), market.quote);
    }
    return [...tokens.values()];
  }

  #token(symbol: string): KuruToken {
    const token = this.#tokens().find((candidate) => candidate.symbol === symbol);
    if (!token) {
      throw new KuruOrderError(`Kuru has no asset ${symbol}`);
    }
    return token;
  }
}

function rejectReduceOnly(request: OrderRequestBase): void {
  if (request.reduceOnly) {
    throw new KuruOrderError('reduceOnly has no meaning on a spot venue');
  }
}
