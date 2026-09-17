/**
 * Shared value types for every Sente venue adapter.
 *
 * Amounts and prices are carried as decimal STRINGS, never `number`. A JS
 * number cannot hold a wei-scale integer and silently rounds mid-size fills,
 * which is the classic way to lose money in a trading client. Adapters convert
 * to and from their venue's native representation at the boundary.
 */

/** Human-readable decimal, e.g. `"1234.5678"`. Never a float. */
export type Decimal = string;

/** Unix epoch milliseconds. */
export type Timestamp = number;

/** Venue-assigned order id. Opaque; do not parse. */
export type OrderId = string;

/** Canonical market symbol as Sente uses it, e.g. `"MON-USDC"`. */
export type MarketSymbol = string;

export type MarketKind = 'spot' | 'perp';

export type Side = 'buy' | 'sell';

export type OrderType = 'limit' | 'market';

/**
 * Time in force.
 * - `GTC` rest on the book until filled or cancelled
 * - `IOC` fill what you can immediately, cancel the rest
 * - `FOK` fill entirely and immediately or not at all
 * - `POST_ONLY` reject if the order would take liquidity
 */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';

export type OrderStatus =
  'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

/** Candle interval. Adapters map these onto whatever the venue supports. */
export type KlineInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface Market {
  /** Canonical symbol used across Sente. */
  symbol: MarketSymbol;
  kind: MarketKind;
  base: string;
  quote: string;
  /** Smallest price increment the venue accepts. */
  tickSize: Decimal;
  /** Smallest size increment the venue accepts. */
  stepSize: Decimal;
  /** Smallest order size the venue accepts, in base units. */
  minSize: Decimal;
  /** Smallest order notional the venue accepts, in quote units, when enforced. */
  minNotional?: Decimal;
  /** Perp only: highest leverage the venue permits on this market. */
  maxLeverage?: number;
  /** Venue's own identifier, when it differs from `symbol`. */
  venueSymbol?: string;
}

/** One price level of a book. */
export interface DepthLevel {
  price: Decimal;
  /** Total resting size at this price, in base units. */
  size: Decimal;
}

export interface Depth {
  symbol: MarketSymbol;
  /** Descending by price — best bid first. */
  bids: DepthLevel[];
  /** Ascending by price — best ask first. */
  asks: DepthLevel[];
  timestamp: Timestamp;
  /** Book sequence number, when the venue exposes one. */
  sequence?: number;
}

export interface Kline {
  /** Open time of the candle. */
  openTime: Timestamp;
  closeTime: Timestamp;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** Volume in base units. */
  volume: Decimal;
  /** Volume in quote units, when the venue reports it. */
  quoteVolume?: Decimal;
}

/**
 * Result of simulating an order against the current book. Adapters must not
 * place anything to produce a quote.
 */
export interface Quote {
  symbol: MarketSymbol;
  side: Side;
  /** Size requested, in base units. */
  size: Decimal;
  /** Size that would actually fill. Less than `size` if the book is thin. */
  fillableSize: Decimal;
  /** Size-weighted average execution price. */
  averagePrice: Decimal;
  /** Quote-unit cost (buy) or proceeds (sell), fees excluded. */
  notional: Decimal;
  /** Signed fraction against mid, e.g. `0.0042` is 42 bps of adverse slippage. */
  slippage: Decimal;
  /** Estimated fee in quote units. */
  estimatedFee?: Decimal;
  timestamp: Timestamp;
}

export interface Fill {
  orderId: OrderId;
  /** Venue-assigned trade id, when available. */
  tradeId?: string;
  symbol: MarketSymbol;
  side: Side;
  price: Decimal;
  size: Decimal;
  /** Fee charged for this fill. Positive is paid, negative is a rebate. */
  fee: Decimal;
  feeAsset: string;
  /** True when this fill added liquidity. */
  maker: boolean;
  timestamp: Timestamp;
}

export interface Order {
  id: OrderId;
  /** Caller-supplied idempotency key, echoed back when the venue supports it. */
  clientOrderId?: string;
  symbol: MarketSymbol;
  side: Side;
  type: OrderType;
  status: OrderStatus;
  /** Limit price. Absent on market orders. */
  price?: Decimal;
  /** Original size in base units. */
  size: Decimal;
  /** Cumulative filled size in base units. */
  filledSize: Decimal;
  /** Size-weighted average fill price so far. */
  averageFillPrice?: Decimal;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** On-chain transaction hash, for venues that settle per order. */
  txHash?: string;
  /**
   * Block the fills were confirmed in (SEN-20). Kuru: from the execution
   * receipt; Perpl: from the order's own `at.b`. Absent when the venue path
   * does not report one.
   */
  blockNumber?: number;
  /**
   * Perpl: leverage this order carries (`lv / 100`), e.g. 3 for 3x.
   * Meaningless on a spot venue.
   */
  leverage?: number;
  /** Fee charged on the fills so far, in quote/collateral units, when known. */
  fee?: Decimal;
  /** The asset `fee` is denominated in. */
  feeAsset?: string;
  /**
   * Perps only, set by `closePosition`: the position's realised price PnL at
   * the close (Perpl's `dpnl`), in collateral units. Cumulative over the
   * position's life, not only this close.
   */
  realizedPnl?: Decimal;
  /** Collateral paid (positive = paid out) as funding on that position (Perpl's `fnd`, sign-flipped). */
  fundingPaid?: Decimal;
}

export interface Balance {
  asset: string;
  /** Spendable right now. */
  available: Decimal;
  /** Reserved by resting orders or margin. */
  locked: Decimal;
  /** `available + locked`. */
  total: Decimal;
}

export type PositionSide = 'long' | 'short';

export type MarginMode = 'cross' | 'isolated';

export interface Position {
  symbol: MarketSymbol;
  side: PositionSide;
  /** Absolute size in base units. Direction lives in `side`. */
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  liquidationPrice?: Decimal;
  leverage: number;
  marginMode: MarginMode;
  /** Margin currently allocated to this position, in quote units. */
  margin: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl?: Decimal;
  /** Cumulative funding paid (positive) or received (negative). */
  fundingPaid?: Decimal;
  updatedAt: Timestamp;
}

/** Common shape of an order request. */
export interface OrderRequestBase {
  symbol: MarketSymbol;
  side: Side;
  /** Size in base units. */
  size: Decimal;
  /** Idempotency key. Adapters must forward it when the venue supports one. */
  clientOrderId?: string;
  /** Perps: only ever reduce an existing position, never open or flip one. */
  reduceOnly?: boolean;
}

export interface LimitOrderRequest extends OrderRequestBase {
  price: Decimal;
  timeInForce?: TimeInForce;
  /** Expiry for GTC orders on venues that require one. */
  expiresAt?: Timestamp;
}

export interface MarketOrderRequest extends OrderRequestBase {
  /**
   * Worst acceptable execution price. Adapters SHOULD refuse to submit without
   * one — an unbounded market order on a thin book is an unbounded loss.
   */
  slippageLimitPrice?: Decimal;
  /** Maximum tolerated slippage as a fraction, e.g. `"0.01"` for 1%. */
  maxSlippage?: Decimal;
}

export interface CancelRequest {
  symbol: MarketSymbol;
  orderId: OrderId;
}

export interface KlineQuery {
  symbol: MarketSymbol;
  interval: KlineInterval;
  /** Inclusive lower bound. */
  startTime?: Timestamp;
  /** Exclusive upper bound. */
  endTime?: Timestamp;
  /** Most recent N candles when no range is given. */
  limit?: number;
}

export interface QuoteRequest {
  symbol: MarketSymbol;
  side: Side;
  /** Size in base units. */
  size: Decimal;
}

export interface DepthQuery {
  symbol: MarketSymbol;
  /** Levels per side. Adapters clamp to whatever the venue allows. */
  limit?: number;
}
