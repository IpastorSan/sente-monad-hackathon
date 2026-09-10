import { divRound, fromScaled, toScaled, unit } from './decimal.ts';
import { PerplRest } from './rest.ts';
import { ServerClock } from './signing.ts';
import { PerplTradingSocket, OPEN_ORDER_STATUSES } from './trading.ts';
import { ORDER_FLAGS, ORDER_STATUS, ORDER_TYPE, POSITION_SIDE } from './wire.ts';
import { defaultWebSocket, fetchBookSnapshot } from './ws.ts';
export const PERPL_NETWORKS = {
  testnet: {
    restUrl: 'https://testnet.perpl.xyz/api',
    wsUrl: 'wss://testnet.perpl.xyz',
    chainId: 10143,
  },
  mainnet: { restUrl: 'https://app.perpl.xyz/api', wsUrl: 'wss://app.perpl.xyz', chainId: 143 },
};
export function resolveMarket(context, raw) {
  const instance = context.instances.find((i) => i.id === raw.instance_id) ?? context.instances[0];
  const token = context.tokens.find((t) => t.id === instance?.collateral_token_id);
  if (!token) throw new Error(`Perpl context has no collateral token for market ${raw.symbol}`);
  return {
    raw,
    symbol: `${raw.symbol}-PERP`,
    pd: raw.config.price_decimals,
    sd: raw.config.size_decimals,
    cd: token.decimals,
    collateral: token.symbol,
  };
}
const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': undefined, // Perpl's longest resolution is 1d
};
const TIF_FLAGS = {
  GTC: ORDER_FLAGS.GoodTillCancel,
  POST_ONLY: ORDER_FLAGS.PostOnly,
  FOK: ORDER_FLAGS.FillOrKill,
  IOC: ORDER_FLAGS.ImmediateOrCancel,
};
const MAX_CANDLES = 1024;
/** An order has left the book, one way or another. */
const isTerminal = (o) => !!o.r || !OPEN_ORDER_STATUSES.has(o.st);
/** A resting order has been placed (or already finished). */
const isPlaced = (o) => o.st !== ORDER_STATUS.Pending;
function orderSide(t) {
  return t === ORDER_TYPE.OpenLong || t === ORDER_TYPE.CloseShort ? 'buy' : 'sell';
}
function orderStatus(o) {
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
function txHash(txid) {
  if (!txid) return undefined;
  return txid.startsWith('0x') ? txid : `0x${txid}`;
}
export function toOrder(o, m, extra = {}) {
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
    createdAt: o.c?.t ?? o.at.t ?? Date.now(),
    updatedAt: o.at.t ?? Date.now(),
    ...(hash ? { txHash: hash } : {}),
  };
}
/** Collateral (raw token units) rescaled to price×size units. */
function collateralToNotional(amount, m) {
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
export function toPosition(p, m, markPrice) {
  const side = p.sd === POSITION_SIDE.Long ? 1n : -1n;
  const entry = BigInt(p.ep);
  const size = BigInt(p.s);
  const deposit = BigInt(p.c);
  const maintenance = BigInt(m.raw.config.maintenance_margin);
  let liquidationPrice;
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
/** A bigint headed for a JSON number frame. Perpl's scaled values fit, but check. */
function wireNumber(value, what) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} out of range: ${value}`);
  return n;
}
export class PerplVenue {
  id = 'perpl';
  name = 'Perpl';
  kind = 'perps';
  rest;
  trading;
  network;
  webSocket;
  defaultLeverage;
  defaultCloseSlippage;
  contextMaxAgeMs;
  leverage = new Map();
  cached = null;
  constructor(options) {
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
  close() {
    this.trading.close();
  }
  // --- reads -------------------------------------------------------------
  async getMarkets() {
    const context = await this.context();
    return context.markets
      .filter((raw) => raw.config.is_open)
      .map((raw) => {
        const m = resolveMarket(context, raw);
        return {
          symbol: m.symbol,
          kind: 'perp',
          base: raw.symbol,
          quote: m.collateral,
          tickSize: unit(m.pd),
          stepSize: unit(m.sd),
          minSize: unit(m.sd),
          maxLeverage: raw.config.initial_margin / 100,
          venueSymbol: raw.symbol,
        };
      });
  }
  async getDepth({ symbol, limit }) {
    const m = await this.market(symbol);
    const book = await fetchBookSnapshot(this.network.wsUrl, m.raw.id, {
      webSocket: this.webSocket,
    });
    const level = (l) => ({
      price: fromScaled(l.p, m.pd),
      size: fromScaled(l.s, m.sd),
    });
    const bids = [...book.bid].filter((l) => l.s > 0).sort((a, b) => b.p - a.p);
    const asks = [...book.ask].filter((l) => l.s > 0).sort((a, b) => a.p - b.p);
    return {
      symbol,
      bids: bids.slice(0, limit ?? bids.length).map(level),
      asks: asks.slice(0, limit ?? asks.length).map(level),
      timestamp: book.at.t ?? Date.now(),
      ...(book.sn !== undefined ? { sequence: book.sn } : {}),
    };
  }
  /**
   * Candles, oldest first.
   *
   * `volume` IS AN ESTIMATE. Perpl publishes candle volume only in collateral
   * units (`v`), which is reported exactly as `quoteVolume`; base volume is
   * derived as `quoteVolume / typical price ((h + l + c) / 3)`. Use
   * `quoteVolume` wherever exactness matters.
   */
  async getKlines({ symbol, interval, startTime, endTime, limit }) {
    const resolution = INTERVAL_SECONDS[interval];
    if (resolution === undefined) throw new Error(`Perpl has no ${interval} candles`);
    const m = await this.market(symbol);
    const step = resolution * 1000;
    const to = (endTime ?? Date.now()) - 1; // endTime is exclusive
    const count = Math.min(limit ?? 100, MAX_CANDLES);
    const from = startTime ?? to - count * step;
    const series = await this.rest.candles(m.raw.id, resolution, from, to);
    const candles = series.d
      .filter((c) => c.t >= from && c.t <= to)
      .sort((a, b) => a.t - b.t)
      .slice(-count);
    return candles.map((c) => {
      const quote = BigInt(c.v);
      const typical3 = BigInt(c.h) + BigInt(c.l) + BigInt(c.c); // 3 × typical, scaled pd
      // base (scaled sd) = quote / 10^cd / (typical / 10^pd) · 10^sd
      const base =
        typical3 > 0n
          ? divRound(quote * 3n * 10n ** BigInt(m.pd + m.sd), typical3 * 10n ** BigInt(m.cd))
          : 0n;
      return {
        openTime: c.t,
        closeTime: c.t + step,
        open: fromScaled(c.o, m.pd),
        high: fromScaled(c.h, m.pd),
        low: fromScaled(c.l, m.pd),
        close: fromScaled(c.c, m.pd),
        volume: fromScaled(base, m.sd),
        quoteVolume: fromScaled(quote, m.cd),
      };
    });
  }
  /** Walks a fresh book snapshot. Places nothing. */
  async quote({ symbol, side, size }) {
    const m = await this.market(symbol);
    const wanted = toScaled(size, m.sd);
    const book = await fetchBookSnapshot(this.network.wsUrl, m.raw.id, {
      webSocket: this.webSocket,
    });
    const asks = [...book.ask].filter((l) => l.s > 0).sort((a, b) => a.p - b.p);
    const bids = [...book.bid].filter((l) => l.s > 0).sort((a, b) => b.p - a.p);
    let filled = 0n;
    let cost = 0n; // Σ price·size, scaled pd+sd
    for (const level of side === 'buy' ? asks : bids) {
      if (filled >= wanted) break;
      const take = BigInt(level.s) < wanted - filled ? BigInt(level.s) : wanted - filled;
      filled += take;
      cost += take * BigInt(level.p);
    }
    // Twice the mid, so it stays an integer.
    const mid2 = bids[0] && asks[0] ? BigInt(bids[0].p) + BigInt(asks[0].p) : 0n;
    let slippage = '0';
    if (filled > 0n && mid2 > 0n) {
      // (avg − mid) / mid  ==  (2·cost − mid2·filled) / (mid2·filled); adverse is positive.
      const adverse = side === 'buy' ? 2n * cost - mid2 * filled : mid2 * filled - 2n * cost;
      slippage = fromScaled(divRound(adverse * 10n ** 8n, mid2 * filled), 8);
    }
    return {
      symbol,
      side,
      size,
      fillableSize: fromScaled(filled, m.sd),
      averagePrice: filled > 0n ? fromScaled(divRound(cost * 10n ** 4n, filled), m.pd + 4) : '0',
      notional: fromScaled(cost, m.pd + m.sd),
      slippage,
      estimatedFee: fromScaled(
        divRound(cost * BigInt(m.raw.config.taker_fee), 1000000n),
        m.pd + m.sd,
      ),
      timestamp: book.at.t ?? Date.now(),
    };
  }
  async getOpenOrders(symbol) {
    await this.connectTrading();
    const context = await this.context();
    return this.trading
      .openOrders()
      .map((o) => ({ o, raw: context.markets.find((m) => m.id === o.mkt) }))
      .filter((x) => !!x.raw)
      .map(({ o, raw }) => toOrder(o, resolveMarket(context, raw)))
      .filter((order) => !symbol || order.symbol === symbol);
  }
  /**
   * One balance: the collateral token. `available` is the account's free
   * balance; `locked` is what resting orders reserve plus the collateral
   * deposited in open positions (Perpl moves a position's margin out of the
   * account balance and into the position).
   */
  async getBalances() {
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
  async getPositions(symbol) {
    await this.connectTrading();
    const context = await this.context(0); // fresh mark prices
    const positions = [];
    for (const p of this.trading.openPositions()) {
      const raw = context.markets.find((m) => m.id === p.mkt);
      if (!raw) continue;
      const m = resolveMarket(context, raw);
      if (symbol && m.symbol !== symbol) continue;
      positions.push(toPosition(p, m, BigInt(raw.state.mrk)));
    }
    return positions;
  }
  // --- writes ------------------------------------------------------------
  async placeLimit(request) {
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
  async placeMarket(request) {
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
  async cancel({ symbol, orderId }) {
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
  async setLeverage({ symbol, leverage, marginMode }) {
    if (marginMode === 'cross') throw new Error('Perpl supports isolated margin only');
    if (!(leverage > 0)) throw new Error(`leverage must be positive, got ${leverage}`);
    const m = await this.market(symbol);
    this.leverage.set(symbol, Math.min(leverage, m.raw.config.initial_margin / 100));
  }
  async closePosition({ symbol, size, slippageLimitPrice }) {
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
    return toOrder(order, m, { type: 'market', timeInForce: 'IOC' });
  }
  // --- internals ---------------------------------------------------------
  async submit(fields, settled) {
    await this.connectTrading();
    return this.trading.submit(fields, { settled });
  }
  /** Sign-in has the same 30s window as REST, so the clock is synced first. */
  async connectTrading() {
    if (!this.rest.clock.isSynced) await this.rest.syncClock();
    await this.trading.connect();
  }
  async context(maxAgeMs = this.contextMaxAgeMs) {
    if (this.cached && Date.now() - this.cached.at <= maxAgeMs) return this.cached.context;
    const context = await this.rest.context();
    this.cached = { context, at: Date.now() };
    return context;
  }
  async market(symbol, maxAgeMs) {
    const context = await this.context(maxAgeMs);
    const raw = context.markets.find((m) => `${m.symbol}-PERP` === symbol);
    if (!raw) throw new Error(`Perpl has no market ${symbol}`);
    if (!raw.config.is_open) throw new Error(`Perpl market ${symbol} is closed`);
    return resolveMarket(context, raw);
  }
  openType(side, reduceOnly = false) {
    if (reduceOnly) return side === 'buy' ? ORDER_TYPE.CloseShort : ORDER_TYPE.CloseLong;
    return side === 'buy' ? ORDER_TYPE.OpenLong : ORDER_TYPE.OpenShort;
  }
  leverageHundredths(m) {
    const leverage = this.leverage.get(m.symbol) ?? this.defaultLeverage;
    return Math.round(Math.min(leverage, m.raw.config.initial_margin / 100) * 100);
  }
  /**
   * The worst price an immediate order may fill at. Rounded to the tick in the
   * conservative direction: a buy's ceiling rounds down, a sell's floor up.
   */
  boundPrice(m, side, limitPrice, maxSlippage) {
    if (limitPrice !== undefined)
      return toScaled(limitPrice, m.pd, side === 'buy' ? 'floor' : 'ceil');
    if (maxSlippage === undefined) {
      throw new Error('refusing an unbounded market order: pass slippageLimitPrice or maxSlippage');
    }
    let micros = toScaled(maxSlippage, 6, 'floor');
    const cap = BigInt(m.raw.order_max_market_slippage_bps) * 100n;
    if (micros > cap) micros = cap;
    if (micros < 0n) throw new Error(`maxSlippage must not be negative, got ${maxSlippage}`);
    const mark = BigInt(m.raw.state.mrk);
    return side === 'buy'
      ? (mark * (1000000n + micros)) / 1000000n
      : (mark * (1000000n - micros) + 999999n) / 1000000n;
  }
}
