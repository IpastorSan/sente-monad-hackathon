/**
 * The phone's Perpl trader (SEN-105, plan M-T23).
 *
 * Perpl authenticates per SOCKET, not per order: the `mt: 29` sign-in frame is
 * Ed25519-signed and every later `mt: 22` order frame rides on it unsigned. So
 * whoever holds a trade-scoped key can place any order, and decision D1 of
 * docs/design/trading/plan-trading.md (Architecture §3) keeps that key on the
 * phone: the phone opens the trading WebSocket itself, over React Native's
 * global `WebSocket`, and the server never holds a key that can trade.
 *
 * This wraps `PerplVenue` from `@sente/venues/perpl` rather than re-implementing
 * the socket protocol, and adds the rules a hand-held trader needs on top:
 *
 * - LEVERAGE is refused above the market's maximum instead of silently clamped
 *   (the adapter clamps; a user who asked for 50x must not get a 20x position
 *   they did not see), and refused when finer than the wire's hundredths.
 * - NO UNBOUNDED MARKET ORDER: `maxSlippage` is mandatory and validated here,
 *   and the adapter caps it further at the market's own slippage limit.
 * - ONE SOCKET PER ACTION, closed when the action ends, and actions run one at
 *   a time. A phone backgrounds and loses sockets at will, so a held socket
 *   buys little; and two concurrent sockets would each seed their `rq` from
 *   the same `lfr`, and Perpl executes a duplicate `rq` at most once — the
 *   second order would silently vanish.
 * - `release()` zeroes the trader's copy of the secret key and closes whatever
 *   socket is open, so a released trader can never sign in again.
 */
import type {
  Decimal,
  MarketSymbol,
  Order,
  OrderId,
  Position,
  Side,
  TimeInForce,
} from '@sente/venues';
import {
  PERPL_NETWORKS,
  PerplVenue,
  defaultWebSocket,
  type PerplCredentials,
  type WebSocketFactory,
  type WebSocketLike,
} from '@sente/venues/perpl';

export interface PerplTraderOptions {
  /**
   * The phone's enrolled trade key. The trader copies `secretKey`, so the
   * caller can (and should) zero its own buffer right after this call.
   */
  readonly credentials: PerplCredentials;
  /** e.g. `https://testnet.perpl.xyz/api`. */
  readonly restUrl: string;
  /** e.g. `wss://testnet.perpl.xyz`. */
  readonly wsUrl: string;
  /** Signed into every sign-in frame. Defaults to Monad testnet (10143). */
  readonly chainId?: number;
  /** Defaults to the global `WebSocket` (React Native's on device). Tests inject a fake. */
  readonly webSocket?: WebSocketFactory;
  readonly fetchImpl?: typeof fetch;
}

interface OrderBase {
  readonly symbol: MarketSymbol;
  readonly side: Side;
  /** Base units, e.g. `"0.01"` BTC. */
  readonly size: Decimal;
  /** e.g. `5` for 5x. Refused above the market maximum; hundredths at most. */
  readonly leverage: number;
  readonly reduceOnly?: boolean;
  readonly clientOrderId?: string;
}

export interface PerplMarketOrder extends OrderBase {
  /** Required: worst fill as a fraction of mark, e.g. `"0.01"` for 1%. */
  readonly maxSlippage: Decimal;
}

export interface PerplLimitOrder extends OrderBase {
  readonly price: Decimal;
  readonly timeInForce?: TimeInForce;
}

export interface PerplClose {
  readonly symbol: MarketSymbol;
  /** Base units to close; omit to close the whole position. */
  readonly size?: Decimal;
  readonly maxSlippage: Decimal;
}

export interface PerplTrader {
  placeMarket(order: PerplMarketOrder): Promise<Order>;
  placeLimit(order: PerplLimitOrder): Promise<Order>;
  cancel(request: { symbol: MarketSymbol; orderId: OrderId }): Promise<Order>;
  closePosition(request: PerplClose): Promise<Order>;
  positions(symbol?: MarketSymbol): Promise<Position[]>;
  openOrders(symbol?: MarketSymbol): Promise<Order[]>;
  /** Zeroes the key and closes any open socket. Every later call throws. */
  release(): void;
}

/** Refused before anything was sent: nothing reached Perpl. */
export class PerplTraderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerplTraderError';
  }
}

/** A non-negative plain decimal: `"0.01"`, `"1"`. No sign, exponent or blank. */
const DECIMAL = /^(?:\d+|\d*\.\d+)$/;

function requireSlippage(maxSlippage: unknown): Decimal {
  if (typeof maxSlippage !== 'string' || !DECIMAL.test(maxSlippage)) {
    throw new PerplTraderError(
      `refusing an unbounded market order: maxSlippage must be a decimal fraction, got ${String(maxSlippage)}`,
    );
  }
  return maxSlippage;
}

function requireLeverageShape(leverage: number): void {
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new PerplTraderError(`leverage must be a positive number, got ${leverage}`);
  }
  // Perpl's `lv` is an integer in hundredths; the adapter would round 2.555x
  // UP to 2.56x, i.e. more leverage than the user chose.
  const hundredths = leverage * 100;
  if (Math.abs(hundredths - Math.round(hundredths)) > 1e-9) {
    throw new PerplTraderError(`leverage ${leverage} is finer than Perpl's 0.01x step`);
  }
}

export function createPerplTrader(options: PerplTraderOptions): PerplTrader {
  // A private copy, so `release()` can zero it whatever the caller does with theirs.
  const secretKey = Uint8Array.from(options.credentials.secretKey);
  const credentials: PerplCredentials = { apiKey: options.credentials.apiKey, secretKey };
  const network = {
    restUrl: options.restUrl,
    wsUrl: options.wsUrl,
    chainId: options.chainId ?? PERPL_NETWORKS.testnet.chainId,
  };
  const openSocket = options.webSocket ?? defaultWebSocket;

  let released = false;
  // Every socket an action opened and has not yet closed. Tracked here rather
  // than trusted to `PerplVenue.close()`, which cannot reach a trading socket
  // still mid-sign-in.
  const sockets = new Set<WebSocketLike>();
  let queue: Promise<unknown> = Promise.resolve();

  const trackedSocket: WebSocketFactory = (url) => {
    if (released) throw new PerplTraderError('this Perpl trader was released');
    const ws = openSocket(url);
    sockets.add(ws);
    const close = ws.close.bind(ws);
    ws.close = (code, reason) => {
      sockets.delete(ws);
      close(code, reason);
    };
    return ws;
  };

  const closeAll = () => {
    for (const ws of [...sockets]) ws.close(1000, 'released');
  };

  /** One venue, one socket, one action; queued behind the previous action. */
  function act<T>(
    run: (venue: PerplVenue) => Promise<T>,
    extra: { defaultCloseSlippage?: Decimal } = {},
  ): Promise<T> {
    const result = queue.then(async () => {
      if (released) throw new PerplTraderError('this Perpl trader was released');
      const venue = new PerplVenue({
        credentials,
        network,
        webSocket: trackedSocket,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...extra,
      });
      try {
        return await run(venue);
      } finally {
        venue.close();
        closeAll();
      }
    });
    queue = result.catch(() => undefined);
    return result;
  }

  /** Checks `leverage` against the market's live maximum, then arms it for the next order. */
  async function armLeverage(venue: PerplVenue, symbol: MarketSymbol, leverage: number) {
    const market = (await venue.getMarkets()).find((m) => m.symbol === symbol);
    if (!market) throw new PerplTraderError(`Perpl has no open market ${symbol}`);
    if (market.maxLeverage !== undefined && leverage > market.maxLeverage) {
      throw new PerplTraderError(
        `${leverage}x is above ${symbol}'s maximum of ${market.maxLeverage}x`,
      );
    }
    await venue.setLeverage({ symbol, leverage });
  }

  return {
    async placeMarket(order) {
      const maxSlippage = requireSlippage(order.maxSlippage);
      requireLeverageShape(order.leverage);
      return act(async (venue) => {
        await armLeverage(venue, order.symbol, order.leverage);
        // Only `maxSlippage`, never a caller-supplied limit price: the bound is
        // always computed from Perpl's fresh mark.
        return venue.placeMarket({
          symbol: order.symbol,
          side: order.side,
          size: order.size,
          maxSlippage,
          ...(order.reduceOnly !== undefined ? { reduceOnly: order.reduceOnly } : {}),
          ...(order.clientOrderId !== undefined ? { clientOrderId: order.clientOrderId } : {}),
        });
      });
    },

    async placeLimit(order) {
      requireLeverageShape(order.leverage);
      return act(async (venue) => {
        await armLeverage(venue, order.symbol, order.leverage);
        return venue.placeLimit({
          symbol: order.symbol,
          side: order.side,
          size: order.size,
          price: order.price,
          ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
          ...(order.reduceOnly !== undefined ? { reduceOnly: order.reduceOnly } : {}),
          ...(order.clientOrderId !== undefined ? { clientOrderId: order.clientOrderId } : {}),
        });
      });
    },

    cancel(request) {
      return act((venue) => venue.cancel(request));
    },

    async closePosition({ symbol, size, maxSlippage }) {
      // The adapter bounds a close by its default slippage; this venue is
      // built for the one close, so that default IS the caller's bound.
      const bound = requireSlippage(maxSlippage);
      return act(
        (venue) => venue.closePosition({ symbol, ...(size !== undefined ? { size } : {}) }),
        { defaultCloseSlippage: bound },
      );
    },

    positions(symbol) {
      return act((venue) => venue.getPositions(symbol));
    },

    openOrders(symbol) {
      return act((venue) => venue.getOpenOrders(symbol));
    },

    release() {
      released = true;
      secretKey.fill(0);
      closeAll();
    },
  };
}
