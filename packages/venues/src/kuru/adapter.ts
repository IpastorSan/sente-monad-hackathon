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
import {
  erc20Abi,
  getAbiItem,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

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
  kuruSlippageBound,
  simulateQuote,
  toDepth,
  toKlines,
  toMarket,
  toOpenOrder,
  toMakerFill,
  toPlacedOrder,
  type BookLevel,
  type MakerFill,
} from './mapping.ts';
import {
  approveBuilderCall,
  builderApprovalCovers,
  cancelOrderCall,
  builderFeePaidAtoms,
  decodeMakerFills,
  decodeOrderOutcome,
  depositCalls,
  encodeNativeOrder,
  formatOrderId,
  KURU_ACCOUNT_CORE_BUILDER_APPROVAL_ABI,
  KuruOrderError,
  parseOrderId,
  placeOrderCall,
  toClientOrderId,
  withdrawCall,
  type KuruBuilderApproval,
  type KuruBuilderFee,
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
  /**
   * Block the execution was confirmed in (SEN-20), when the submitter read it
   * off the receipt. Absent from a submitter that does not surface one.
   */
  blockNumber?: number;
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

/**
 * A builder fee on every order this venue places (SEN-184), and how the
 * account's approval of that builder is kept current.
 */
export type KuruBuilderSettings = KuruBuilderFee & {
  /**
   * How far out to approve the builder: a fixed Unix-seconds `at` (an agent's
   * mandate `expiresAt`, which its policy pins as the ceiling) or `ttlSeconds`
   * from now (a user's year).
   */
  readonly approvalExpiry: { readonly at: bigint } | { readonly ttlSeconds: number };
  /** Re-approve when the current approval has less than this left. Default 1 day. */
  readonly renewWithinSeconds?: number;
};

/** Re-approve a builder once its approval has less than a day to run. */
export const BUILDER_APPROVAL_RENEW_WITHIN_SECONDS = 86_400;

export type KuruVenueConfig = {
  readonly publicClient: PublicClient;
  /**
   * With it, every order pays this builder fee, and `placeLimit`/`placeMarket`
   * first approve the builder when the account's approval does not cover it.
   * Without it, orders use the plain `batch` overloads.
   */
  readonly builder?: KuruBuilderSettings;
  /** The clock builder approvals are checked against, ms. Defaults to `Date.now`. */
  readonly now?: () => number;
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

/**
 * The on-chain book as `quote()` reads it (SEN-63): aggregated levels in book
 * units, best first, with the params needed to decode them. `bestBid`/`bestAsk`
 * are `null` for an empty side, never a sentinel.
 */
export type KuruBookSnapshot = {
  readonly params: KuruMarketParams;
  readonly bids: BookLevel[];
  readonly asks: BookLevel[];
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
  readonly observedAt: number;
};

const TRADES_PACKED = getAbiItem({ abi: kuruAbi.spotOrderBookAbi, name: 'TradesPacked' });

/** Levels per side read for a quote or a book snapshot. */
const QUOTE_LEVELS = 100n;
const GATEWAY_MAX_LEVELS = 200;
const DEFAULT_KLINE_LIMIT = 500;
/** The Data Source's hard cap on candles per request. */
const MAX_CANDLES = 5000;
/** `bestBidAsk()` reports an empty bid side as uint32 max and an empty ask side as 0. */
const EMPTY_BID = 2n ** 32n - 1n;

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
  readonly #builder: KuruBuilderSettings | undefined;
  readonly #now: () => number;
  /**
   * Unix seconds until which the account's builder approval is known to cover
   * the next order, so a venue kept per agent reads `getBuilderApproval` once
   * per approval rather than once per order.
   */
  #approvalCoversUntil = 0;
  #accountId: bigint | undefined;

  constructor(config: KuruVenueConfig) {
    this.#client = config.publicClient;
    this.#builder = config.builder;
    this.#now = config.now ?? Date.now;
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

  /**
   * A market order as calls, validated and encoded but not submitted: the
   * same bounded IOC `placeMarket` sends. Lifted out of `placeMarket` (SEN-84)
   * so a manual order the phone signs goes through exactly the code an
   * agent's order does, unbounded refusal included.
   */
  async marketOrderCalls(request: MarketOrderRequest): Promise<KuruCall[]> {
    return [(await this.#prepareMarket(request)).call];
  }

  /** The builder fee every order of this venue pays, if any (SEN-184). */
  get builder(): KuruBuilderFee | undefined {
    const builder = this.#builder;
    return builder ? { address: builder.address, feePps: builder.feePps } : undefined;
  }

  /** `getBuilderApproval(account, builder)`: what this account has approved `builder` for. */
  async builderApproval(builder: Address): Promise<KuruBuilderApproval> {
    const raw = (await this.#client.readContract({
      address: this.#accountCore,
      abi: KURU_ACCOUNT_CORE_BUILDER_APPROVAL_ABI,
      functionName: 'getBuilderApproval',
      args: [this.#requireAccount(), builder],
    })) as { maxFeePps: number; expiry: bigint; active: boolean };
    return { maxFeePps: Number(raw.maxFeePps), expiry: BigInt(raw.expiry), active: raw.active };
  }

  /**
   * `[approveBuilder]` when this account's approval of the configured builder
   * is missing, expired or soon to be, or below the rate; `[]` when it covers
   * the next order, or when no builder is configured.
   */
  async builderApprovalCalls(): Promise<KuruCall[]> {
    const builder = this.#builder;
    if (!builder) return [];
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (nowSeconds < this.#approvalCoversUntil) return [];
    const approval = await this.builderApproval(builder.address);
    const renew = builder.renewWithinSeconds ?? BUILDER_APPROVAL_RENEW_WITHIN_SECONDS;
    if (builderApprovalCovers(approval, builder.feePps, nowSeconds, renew)) {
      this.#approvalCoversUntil = Number(approval.expiry) - renew;
      return [];
    }
    const expiry =
      'at' in builder.approvalExpiry
        ? builder.approvalExpiry.at
        : BigInt(nowSeconds + builder.approvalExpiry.ttlSeconds);
    return [approveBuilderCall(this.#accountCore, builder.address, builder.feePps, expiry)];
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

  /**
   * The top `QUOTE_LEVELS` of the live on-chain book plus the market params,
   * read together. Chain, not Gateway, because a quote or a slippage bound
   * shown to a user is about to be signed against (SEN-63).
   */
  async bookSnapshot(symbol: MarketSymbol): Promise<KuruBookSnapshot> {
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
    const bids = levels(bidPrices, bidSizes);
    const asks = levels(askPrices, askSizes);
    return {
      params,
      bids,
      asks,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      observedAt: Date.now(),
    };
  }

  async quote({ symbol, side, size }: QuoteRequest): Promise<Quote> {
    const market = this.market(symbol);
    const { params, bids, asks, observedAt } = await this.bookSnapshot(symbol);
    return simulateQuote({
      symbol,
      side,
      size,
      params,
      quoteDecimals: market.quote.decimals,
      bids,
      asks,
      observedAt,
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
   * Every maker fill on `symbol`'s book in blocks `fromBlock..toBlock`
   * inclusive, WHOEVER the maker is (SEN-149). A resting order's later fills
   * appear only in the takers' transactions, and the maker's id is packed into
   * the log data rather than a topic, so the read cannot be narrowed to one
   * account: callers read a market once and match every order they watch.
   *
   * Chain logs rather than the Data Source's order history or the Gateway's
   * open orders: the history has no fill event at all, and the open-orders
   * snapshot only shows a shrinking remainder — neither gives each fill's
   * size, fee, block or a stable identity to record it once by. Callers keep
   * the range within their RPC's `eth_getLogs` cap (100 blocks on Monad's
   * public endpoint).
   */
  async makerFills(symbol: MarketSymbol, fromBlock: bigint, toBlock: bigint): Promise<MakerFill[]> {
    const market = this.market(symbol);
    const logs = await this.#client.getLogs({
      address: market.address,
      event: TRADES_PACKED,
      fromBlock,
      toBlock,
    });
    return decodeMakerFills(logs, market.address).map((fill) => toMakerFill(fill, market));
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

  /**
   * What the account's own WALLET holds of every Kuru market token (native MON
   * for the zero address), as opposed to `getBalances`, which is AccountCore.
   * Deposits move funds from here into AccountCore; orders only use AccountCore.
   */
  async walletBalances(): Promise<Balance[]> {
    const user = this.#requireAccount();
    return Promise.all(
      this.#tokens().map(async (token) => {
        const raw = isAddressEqual(token.address, zeroAddress)
          ? await this.#client.getBalance({ address: user })
          : await this.#client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [user],
            });
        const amount = fromUnits(raw, token.decimals);
        return { asset: token.symbol, available: amount, locked: '0', total: amount };
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
    return this.#place(await this.#prepareMarket(request), 'market', undefined);
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

  async #prepareMarket(request: MarketOrderRequest): Promise<PreparedOrder> {
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
    return this.#prepare(market, params, request, bound, 'IOC');
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
        this.builder,
      ),
    };
  }

  async #place(
    prepared: PreparedOrder,
    type: OrderType,
    price: Decimal | undefined,
  ): Promise<Order> {
    // The approval leg goes first: AccountCore refuses a builder order the
    // account has not approved, and the whole list lands as one unit.
    const approval = await this.builderApprovalCalls();
    let execution: KuruExecution;
    try {
      execution = await this.#submit([...approval, prepared.call]);
    } catch (error) {
      // A revert may be AccountCore refusing a revoked approval: read it again next time.
      this.#approvalCoversUntil = 0;
      throw error;
    }
    // Read after submitting: a first order can arrive in the same batch as the
    // deposit that registers the account.
    const accountId = await this.accountId();
    const order = toPlacedOrder({
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
      blockNumber: execution.blockNumber,
      quoteDecimals: prepared.market.quote.decimals,
      feeAsset: prepared.market.quote.symbol,
    });
    const builder = this.#builder;
    if (!builder) return order;
    // What the builder was actually paid, from AccountCore's own events.
    const quote = prepared.market.quote;
    const paid = builderFeePaidAtoms(
      execution.logs,
      this.#accountCore,
      builder.address,
      accountId,
      quote.address,
    );
    return { ...order, builderFee: fromUnits(paid, quote.decimals), builderFeeAsset: quote.symbol };
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
    const [bid, ask] = await this.#client.readContract({
      address: market.address,
      abi: kuruAbi.spotOrderBookAbi,
      functionName: 'bestBidAsk',
    });
    // The empty-side sentinels are `bestBidAsk()`'s, so they are checked here;
    // the rounding lives in the pure `kuruSlippageBound` (SEN-63).
    const best = BigInt(side === 'buy' ? ask : bid);
    if (side === 'buy' && best === 0n) throw new KuruOrderError(`${market.symbol} has no asks`);
    if (side === 'sell' && best === EMPTY_BID) {
      throw new KuruOrderError(`${market.symbol} has no bids`);
    }
    return kuruSlippageBound(best, side, maxSlippage, params);
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
