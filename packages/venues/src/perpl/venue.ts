/**
 * `PerpsVenue` for Perpl.
 *
 * Reads come from REST (`/pub/context`, candles) and the market-data socket
 * (the book); account state and order entry from the authed trading socket.
 * Canonical symbols are `<BASE>-PERP` (`BTC-PERP`); quote is the collateral
 * token, AUSD.
 *
 * Adapter behaviour the interface leaves to us, documented as it requires:
 *
 * - LEVERAGE is per ORDER on Perpl (`lv`), not per market. `setLeverage`
 *   records the value for this market and applies it to every SUBSEQUENT order;
 *   it never re-margins an open position. Margin is isolated-only.
 * - MARKET ORDERS are sent as IOC limits at a bound price — `slippageLimitPrice`
 *   if given, else mark ± `maxSlippage` (clamped to the market's own
 *   `order_max_market_slippage_bps`). Neither given: refused.
 * - A rejected order THROWS `PerplOrderRejectedError` carrying Perpl's reason
 *   rather than returning a `rejected` Order, because `Order` has no field for
 *   why, and "rejected, reason unknown" is useless to an agent.
 * - `clientOrderId` is echoed back but not sent: Perpl's idempotency key is a
 *   numeric, strictly increasing `rq` the socket assigns.
 */
import type {
  Balance,
  CancelRequest,
  Decimal,
  Depth,
  DepthQuery,
  Fill,
  Kline,
  KlineQuery,
  LimitOrderRequest,
  Market,
  MarketOrderRequest,
  MarketSymbol,
  Order,
  OrderStatus,
  OrderType,
  Position,
  Quote,
  QuoteRequest,
  Side,
  TimeInForce,
} from '../types.ts';
import type { ClosePositionRequest, PerpsVenue, SetLeverageRequest } from '../venue.ts';
import { divRound, fromScaled, toScaled } from './decimal.ts';
import {
  PERPL_NETWORKS,
  bookToDepth,
  fetchPerplKlines,
  perplMarkets,
  perplSlippageBoundScaled,
  quoteFromBook,
  resolveMarket,
  resolveSymbol,
  type PerplNetwork,
  type ResolvedMarket,
} from './public.ts';
import { PerplRest } from './rest.ts';
import { ServerClock, type PerplCredentials } from './signing.ts';
import { PerplTradingSocket, OPEN_ORDER_STATUSES } from './trading.ts';
import {
  ORDER_FLAGS,
  ORDER_STATUS,
  LIQUIDITY_SIDE,
  ORDER_TYPE,
  POSITION_SIDE,
  type PerplContext,
  type PerplFill,
  type PerplL2Book,
  type PerplMarket,
  type PerplOrder,
  type PerplPosition,
} from './wire.ts';
import { defaultWebSocket, fetchBookSnapshot, type WebSocketFactory } from './ws.ts';

// The public reads moved to `public.ts` (SEN-69); re-exported so existing
// imports from `venue.ts` keep working.
export { PERPL_NETWORKS, resolveMarket, type PerplNetwork, type ResolvedMarket };

export interface PerplVenueOptions {
  readonly credentials: PerplCredentials;
  /** Defaults to testnet. */
  readonly network?: PerplNetwork;
  /** Leverage for markets `setLeverage` was never called on. Default 1x. */
  readonly defaultLeverage?: number;
  /** Slippage bound for `closePosition` without a limit price. Default `"0.01"`. */
  readonly defaultCloseSlippage?: Decimal;
  /** How stale `/pub/context` may be for non-price reads. Default 10s. */
  readonly contextMaxAgeMs?: number;
  readonly webSocket?: WebSocketFactory;
  readonly fetchImpl?: typeof fetch;
}

const TIF_FLAGS: Readonly<Record<TimeInForce, number>> = {
  GTC: ORDER_FLAGS.GoodTillCancel,
  POST_ONLY: ORDER_FLAGS.PostOnly,
  FOK: ORDER_FLAGS.FillOrKill,
  IOC: ORDER_FLAGS.ImmediateOrCancel,
};

/** An order has left the book, one way or another. */
const isTerminal = (o: PerplOrder) => !!o.r || !OPEN_ORDER_STATUSES.has(o.st);
/** A resting order has been placed (or already finished). */
const isPlaced = (o: PerplOrder) => o.st !== ORDER_STATUS.Pending;

function orderSide(t: number): Side {
  return t === ORDER_TYPE.OpenLong || t === ORDER_TYPE.CloseShort ? 'buy' : 'sell';
}

function orderStatus(o: PerplOrder): OrderStatus {
  switch (o.st) {
    case ORDER_STATUS.PartiallyFilled:
      return 'partially_filled';
    case ORDER_STATUS.Filled:
    case ORDER_STATUS.Executed:
      return 'filled';
    case ORDER_STATUS.Canceled:
      return 'cancelled';
    case ORDER_STATUS.Expired:
      return 'expired';
    case ORDER_STATUS.Failed:
      return 'rejected';
    default:
      return 'open';
  }
}

/** Perpl sends `txid` without the 0x. */
function txHash(txid: string | undefined): string | undefined {
  if (!txid) return undefined;
  return txid.startsWith('0x') ? txid : `0x${txid}`;
}

export function toOrder(
  o: PerplOrder,
  m: ResolvedMarket,
  extra: { type?: OrderType; clientOrderId?: string; timeInForce?: TimeInForce } = {},
): Order {
  const filled = o.fs ?? 0;
  const hash = txHash(o.at.txid);
  return {
    id: o.oid ? String(o.oid) : `rq:${o.rq}`,
    ...(extra.clientOrderId !== undefined ? { clientOrderId: extra.clientOrderId } : {}),
    symbol: m.symbol,
    side: orderSide(o.t),
    type: extra.type ?? (o.p ? 'limit' : 'market'),
    status: orderStatus(o),
    ...(o.p ? { price: fromScaled(o.p, m.pd) } : {}),
    size: fromScaled(o.os, m.sd),
    filledSize: fromScaled(filled, m.sd),
    ...(filled > 0 && o.fp ? { averageFillPrice: fromScaled(o.fp, m.pd) } : {}),
    ...(extra.timeInForce !== undefined ? { timeInForce: extra.timeInForce } : {}),
    reduceOnly: o.t === ORDER_TYPE.CloseLong || o.t === ORDER_TYPE.CloseShort,
    // The order's own settle block and the leverage it carried (SEN-20).
    // Perpl's frame also has `f`, whose units the repo's docs do not pin down
    // — unlike Kuru, where the fee is computed from an on-chain event, it is
    // left unmapped rather than guessed at.
    ...(o.at.b !== undefined ? { blockNumber: o.at.b } : {}),
    leverage: o.lv / 100,
    createdAt: o.c?.t ?? o.at.t ?? Date.now(),
    updatedAt: o.at.t ?? Date.now(),
    ...(hash ? { txHash: hash } : {}),
  };
}

/**
 * Attach the position's realised PnL to a `closePosition` result (SEN-20).
 *
 * Best-effort by design: the order's terminal event and the position frames
 * are separate messages. When the exchange closed the position, the socket
 * kept its final frame and the settled `dpnl`/`fnd` ride onto the order; when
 * that frame has not arrived — or never comes, on a venue that does not push
 * it — the fields are simply absent.
 */
function withClosePnl(order: Order, closed: PerplPosition | undefined, m: ResolvedMarket): Order {
  if (!closed) return order;
  return {
    ...order,
    // Which position the cumulative figures below are counting (SEN-33): both
    // run for the life of ONE position, so a reader that cannot name it cannot
    // tell a later close of the same position from the first close of the next.
    positionId: String(closed.pid),
    ...(closed.dpnl !== undefined ? { realizedPnl: fromScaled(BigInt(closed.dpnl), m.cd) } : {}),
    // Same sign convention as `toPosition`: `fnd` is received > 0.
    ...(closed.fnd !== undefined ? { fundingPaid: fromScaled(-BigInt(closed.fnd), m.cd) } : {}),
  };
}

/** Collateral (raw token units) rescaled to price×size units. */
function collateralToNotional(amount: bigint, m: ResolvedMarket): bigint {
  const shift = m.pd + m.sd - m.cd;
  return shift >= 0 ? amount * 10n ** BigInt(shift) : divRound(amount, 10n ** BigInt(-shift));
}

/**
 * Perpl position -> Sente position, valued at `markPrice` (scaled).
 *
 * `unrealizedPnl` is price PnL against mark: `side · (mark − entry) · size`,
 * exactly the SDK's `delta_pnl`. Accrued funding (the contract's
 * `premiumPnlCNS`) is not on the WebSocket, so it is excluded from both uPnL and
 * the liquidation price — which is therefore the funding-free figure.
 *
 * Liquidation price follows Perpl's formula (docs + `perpl-sdk`
 * `Position::liquidation_price`):
 *
 *     MMR    = entry · size / MMF          MMF = maintenance_margin / 100
 *     P_liq  = entry + side · (MMR − deposit) / size
 *
 * Sanity: 10x long BTC at $100k with $10k deposit and 4% maintenance liquidates
 * at $94k, Perpl's own worked example (`decimal.test.ts` pins it).
 */
export function toPosition(p: PerplPosition, m: ResolvedMarket, markPrice: bigint): Position {
  const side = p.sd === POSITION_SIDE.Long ? 1n : -1n;
  const entry = BigInt(p.ep);
  const size = BigInt(p.s);
  const deposit = BigInt(p.c);
  const maintenance = BigInt(m.raw.config.maintenance_margin);

  let liquidationPrice: Decimal | undefined;
  if (maintenance > 0n && size > 0n) {
    const mmr = divRound(entry * size * 100n, maintenance);
    const liq = entry + divRound(side * (mmr - collateralToNotional(deposit, m)), size);
    liquidationPrice = fromScaled(liq > 0n ? liq : 0n, m.pd);
  }

  return {
    symbol: m.symbol,
    side: side === 1n ? 'long' : 'short',
    size: fromScaled(size, m.sd),
    entryPrice: fromScaled(entry, m.pd),
    markPrice: fromScaled(markPrice, m.pd),
    ...(liquidationPrice !== undefined ? { liquidationPrice } : {}),
    leverage: p.lv / 100,
    marginMode: 'isolated',
    margin: fromScaled(deposit, m.cd),
    unrealizedPnl: fromScaled(side * (markPrice - entry) * size, m.pd + m.sd),
    ...(p.dpnl !== undefined ? { realizedPnl: fromScaled(BigInt(p.dpnl), m.cd) } : {}),
    // `fnd` is realized funding PnL (received > 0); `fundingPaid` is the reverse sign.
    ...(p.fnd !== undefined ? { fundingPaid: fromScaled(-BigInt(p.fnd), m.cd) } : {}),
    updatedAt: p.at.t ?? Date.now(),
  };
}

/** A Perpl fill with where it landed on chain, which the shared `Fill` has no field for. */
export type PerplFillRecord = Fill & { blockNumber?: number; txHash?: string };

/** One page of fills, newest first; `next` is Perpl's cursor, `null` at the end. */
export interface PerplFillsPage {
  fills: PerplFillRecord[];
  next: string | null;
}

/**
 * Perpl REST fill -> Sente fill (SEN-151). `undefined` for a fill without a
 * price: the wire marks it optional, and a fill at an unknown price is not
 * worth reporting as if it were one at zero.
 */
export function toFill(f: PerplFill, m: ResolvedMarket): PerplFillRecord | undefined {
  if (f.p === undefined) return undefined;
  const hash = txHash(f.at.txid);
  return {
    orderId: String(f.oid),
    // Perpl has no per-match id; the log that carried the fill is unique.
    tradeId: hash && f.at.l !== undefined ? `${hash}:${f.at.l}` : `${f.oid}:${f.at.b ?? 0}`,
    symbol: m.symbol,
    side: orderSide(f.t),
    price: fromScaled(f.p, m.pd),
    size: fromScaled(f.s, m.sd),
    fee: fromScaled(BigInt(f.f), m.cd),
    feeAsset: m.collateral,
    maker: f.l === LIQUIDITY_SIDE.Maker,
    timestamp: f.at.t ?? Date.now(),
    ...(f.at.b !== undefined ? { blockNumber: f.at.b } : {}),
    ...(hash ? { txHash: hash } : {}),
  };
}

/** A bigint headed for a JSON number frame. Perpl's scaled values fit, but check. */
function wireNumber(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} out of range: ${value}`);
  return n;
}

export class PerplVenue implements PerpsVenue {
  readonly id = 'perpl';
  readonly name = 'Perpl';
  readonly kind = 'perps' as const;

  readonly rest: PerplRest;
  readonly trading: PerplTradingSocket;

  private readonly network: PerplNetwork;
  private readonly webSocket: WebSocketFactory;
  private readonly defaultLeverage: number;
  private readonly defaultCloseSlippage: Decimal;
  private readonly contextMaxAgeMs: number;
  private readonly leverage = new Map<MarketSymbol, number>();
  private cached: { context: PerplContext; at: number } | null = null;

  constructor(options: PerplVenueOptions) {
    this.network = options.network ?? PERPL_NETWORKS.testnet;
    this.webSocket = options.webSocket ?? defaultWebSocket;
    this.defaultLeverage = options.defaultLeverage ?? 1;
    this.defaultCloseSlippage = options.defaultCloseSlippage ?? '0.01';
    this.contextMaxAgeMs = options.contextMaxAgeMs ?? 10_000;

    const clock = new ServerClock();
    this.rest = new PerplRest({
      restUrl: this.network.restUrl,
      chainId: this.network.chainId,
      credentials: options.credentials,
      clock,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.trading = new PerplTradingSocket({
      wsUrl: this.network.wsUrl,
      chainId: this.network.chainId,
      credentials: options.credentials,
      clock,
      webSocket: this.webSocket,
    });
  }

  close(): void {
    this.trading.close();
  }

  // --- reads -------------------------------------------------------------

  async getMarkets(): Promise<Market[]> {
    return perplMarkets(await this.context());
  }

  async getDepth({ symbol, limit }: DepthQuery): Promise<Depth> {
    const m = await this.market(symbol);
    return bookToDepth(await this.book(m), m, limit);
  }

  /** Candles, oldest first; `volume` is an estimate (see `candlesToKlines`). */
  async getKlines(query: KlineQuery): Promise<Kline[]> {
    return fetchPerplKlines(this.rest, await this.market(query.symbol), query);
  }

  /** Walks a fresh book snapshot. Places nothing. */
  async quote(request: QuoteRequest): Promise<Quote> {
    const m = await this.market(request.symbol);
    return quoteFromBook(await this.book(m), m, request);
  }

  async getOpenOrders(symbol?: MarketSymbol): Promise<Order[]> {
    await this.connectTrading();
    const context = await this.context();
    return this.trading
      .openOrders()
      .map((o) => ({ o, raw: context.markets.find((m) => m.id === o.mkt) }))
      .filter((x): x is { o: PerplOrder; raw: PerplMarket } => !!x.raw)
      .map(({ o, raw }) => toOrder(o, resolveMarket(context, raw)))
      .filter((order) => !symbol || order.symbol === symbol);
  }

  /**
   * One balance: the collateral token. `available` is the account's free
   * balance; `locked` is what resting orders reserve plus the collateral
   * deposited in open positions (Perpl moves a position's margin out of the
   * account balance and into the position).
   */
  async getBalances(): Promise<Balance[]> {
    await this.connectTrading();
    const account = this.trading.accountState();
    if (!account) return [];
    const context = await this.context();
    const instance = context.instances.find((i) => i.id === account.in) ?? context.instances[0];
    const token = context.tokens.find((t) => t.id === instance?.collateral_token_id);
    if (!token) throw new Error('Perpl context has no collateral token');

    const inPositions = this.trading.openPositions().reduce((sum, p) => sum + BigInt(p.c), 0n);
    const available = BigInt(account.b) - BigInt(account.lb);
    const locked = BigInt(account.lb) + inPositions;
    return [
      {
        asset: token.symbol,
        available: fromScaled(available, token.decimals),
        locked: fromScaled(locked, token.decimals),
        total: fromScaled(available + locked, token.decimals),
      },
    ];
  }

  async getPositions(symbol?: MarketSymbol): Promise<Position[]> {
    await this.connectTrading();
    const context = await this.context(0); // fresh mark prices
    const positions: Position[] = [];
    for (const p of this.trading.openPositions()) {
      const raw = context.markets.find((m) => m.id === p.mkt);
      if (!raw) continue;
      const m = resolveMarket(context, raw);
      if (symbol && m.symbol !== symbol) continue;
      positions.push(toPosition(p, m, BigInt(raw.state.mrk)));
    }
    return positions;
  }

  /**
   * The account's fills, newest first, off the signed REST history (SEN-151).
   * REST only: no trading socket is opened, so a read-scoped key serves it.
   */
  async getFills(options: { count?: number; page?: string } = {}): Promise<PerplFillsPage> {
    const [page, context] = await Promise.all([
      this.rest.history<PerplFill>('fills', options.count ?? 50, options.page),
      this.context(),
    ]);
    const fills: PerplFillRecord[] = [];
    for (const f of page.d) {
      const raw = context.markets.find((m) => m.id === f.mkt);
      const fill = raw ? toFill(f, resolveMarket(context, raw)) : undefined;
      if (fill) fills.push(fill);
    }
    return { fills, next: page.np ? page.np : null };
  }

  // --- writes ------------------------------------------------------------

  async placeLimit(request: LimitOrderRequest): Promise<Order> {
    const m = await this.market(request.symbol);
    const timeInForce = request.timeInForce ?? 'GTC';
    const fl = TIF_FLAGS[timeInForce];
    const immediate = fl === ORDER_FLAGS.ImmediateOrCancel || fl === ORDER_FLAGS.FillOrKill;
    const order = await this.submit(
      {
        mkt: m.raw.id,
        t: this.openType(request.side, request.reduceOnly),
        p: wireNumber(toScaled(request.price, m.pd), 'price'),
        s: wireNumber(toScaled(request.size, m.sd), 'size'),
        fl,
        lv: this.leverageHundredths(m),
      },
      immediate ? isTerminal : isPlaced,
    );
    return toOrder(order, m, {
      type: 'limit',
      timeInForce,
      ...(request.clientOrderId !== undefined ? { clientOrderId: request.clientOrderId } : {}),
    });
  }

  async placeMarket(request: MarketOrderRequest): Promise<Order> {
    const m = await this.market(request.symbol, 0);
    const bound = this.boundPrice(m, request.side, request.slippageLimitPrice, request.maxSlippage);
    const order = await this.submit(
      {
        mkt: m.raw.id,
        t: this.openType(request.side, request.reduceOnly),
        p: wireNumber(bound, 'price'),
        s: wireNumber(toScaled(request.size, m.sd), 'size'),
        fl: ORDER_FLAGS.ImmediateOrCancel,
        lv: this.leverageHundredths(m),
      },
      isTerminal,
    );
    return toOrder(order, m, {
      type: 'market',
      timeInForce: 'IOC',
      ...(request.clientOrderId !== undefined ? { clientOrderId: request.clientOrderId } : {}),
    });
  }

  async cancel({ symbol, orderId }: CancelRequest): Promise<Order> {
    const m = await this.market(symbol);
    await this.connectTrading();
    const oid = Number(orderId);
    const existing = Number.isSafeInteger(oid) ? this.trading.order(oid) : undefined;
    if (!existing) throw new Error(`Perpl has no order ${orderId} on this socket`);
    if (isTerminal(existing)) return toOrder(existing, m); // already done: a no-op

    await this.trading.submit(
      { mkt: m.raw.id, t: ORDER_TYPE.Cancel, oid, s: 0, fl: 0, lv: 0 },
      {
        // The cancel has its own rq, but the event that settles it may be the
        // cancelled order's own update. Accept either.
        matches: (o, rq) => o.rq === rq || o.oid === oid,
        settled: (o) => (o.oid === oid ? isTerminal(o) : isPlaced(o)),
      },
    );
    return toOrder(this.trading.order(oid) ?? existing, m);
  }

  async setLeverage({ symbol, leverage, marginMode }: SetLeverageRequest): Promise<void> {
    if (marginMode === 'cross') throw new Error('Perpl supports isolated margin only');
    if (!(leverage > 0)) throw new Error(`leverage must be positive, got ${leverage}`);
    const m = await this.market(symbol);
    this.leverage.set(symbol, Math.min(leverage, m.raw.config.initial_margin / 100));
  }

  async closePosition({ symbol, size, slippageLimitPrice }: ClosePositionRequest): Promise<Order> {
    const m = await this.market(symbol, 0);
    await this.connectTrading();
    const position = this.trading.openPositions().find((p) => p.mkt === m.raw.id);
    if (!position) throw new Error(`no open Perpl position on ${symbol}`);

    const long = position.sd === POSITION_SIDE.Long;
    const full = BigInt(position.s);
    const wanted = size !== undefined ? toScaled(size, m.sd) : full;
    const order = await this.submit(
      {
        mkt: m.raw.id,
        // Close* orders are reduce-only and clamped to the position by the
        // exchange, so this can never flip it.
        t: long ? ORDER_TYPE.CloseLong : ORDER_TYPE.CloseShort,
        p: wireNumber(
          this.boundPrice(m, long ? 'sell' : 'buy', slippageLimitPrice, this.defaultCloseSlippage),
          'price',
        ),
        s: wireNumber(wanted < full ? wanted : full, 'size'),
        fl: ORDER_FLAGS.ImmediateOrCancel,
        lv: position.lv,
      },
      isTerminal,
    );
    // A full close moves the position to the retained final frame; a partial
    // one stays live with an updated dpnl (SEN-20). Either frame carries the
    // realised PnL the close produced, once it has arrived.
    const settled =
      this.trading.openPositions().find((p) => p.pid === position.pid) ??
      this.trading.closedPosition(position.pid);
    return withClosePnl(toOrder(order, m, { type: 'market', timeInForce: 'IOC' }), settled, m);
  }

  // --- internals ---------------------------------------------------------

  private async submit(
    fields: Parameters<PerplTradingSocket['submit']>[0],
    settled: (o: PerplOrder) => boolean,
  ): Promise<PerplOrder> {
    await this.connectTrading();
    return this.trading.submit(fields, { settled });
  }

  /** Sign-in has the same 30s window as REST, so the clock is synced first. */
  private async connectTrading(): Promise<void> {
    if (!this.rest.clock.isSynced) await this.rest.syncClock();
    await this.trading.connect();
  }

  private async context(maxAgeMs = this.contextMaxAgeMs): Promise<PerplContext> {
    if (this.cached && Date.now() - this.cached.at <= maxAgeMs) return this.cached.context;
    const context = await this.rest.context();
    this.cached = { context, at: Date.now() };
    return context;
  }

  private async market(symbol: MarketSymbol, maxAgeMs?: number): Promise<ResolvedMarket> {
    return resolveSymbol(await this.context(maxAgeMs), symbol);
  }

  /** A fresh snapshot on its own socket. */
  private book(m: ResolvedMarket): Promise<PerplL2Book> {
    return fetchBookSnapshot(this.network.wsUrl, m.raw.id, { webSocket: this.webSocket });
  }

  private openType(side: Side, reduceOnly = false): number {
    if (reduceOnly) return side === 'buy' ? ORDER_TYPE.CloseShort : ORDER_TYPE.CloseLong;
    return side === 'buy' ? ORDER_TYPE.OpenLong : ORDER_TYPE.OpenShort;
  }

  private leverageHundredths(m: ResolvedMarket): number {
    const leverage = this.leverage.get(m.symbol) ?? this.defaultLeverage;
    return Math.round(Math.min(leverage, m.raw.config.initial_margin / 100) * 100);
  }

  /**
   * The worst price an immediate order may fill at. Rounded to the tick in the
   * conservative direction: a buy's ceiling rounds down, a sell's floor up.
   */
  private boundPrice(
    m: ResolvedMarket,
    side: Side,
    limitPrice: Decimal | undefined,
    maxSlippage: Decimal | undefined,
  ): bigint {
    if (limitPrice !== undefined)
      return toScaled(limitPrice, m.pd, side === 'buy' ? 'floor' : 'ceil');
    if (maxSlippage === undefined) {
      throw new Error('refusing an unbounded market order: pass slippageLimitPrice or maxSlippage');
    }
    return perplSlippageBoundScaled(BigInt(m.raw.state.mrk), side, maxSlippage, m).price;
  }
}
