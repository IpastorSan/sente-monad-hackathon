import type {
  Balance,
  CancelRequest,
  Decimal,
  Depth,
  DepthQuery,
  Kline,
  KlineQuery,
  LimitOrderRequest,
  MarginMode,
  Market,
  MarketOrderRequest,
  MarketSymbol,
  Order,
  Position,
  Quote,
  QuoteRequest,
} from './types.ts';

/**
 * The one interface every Sente venue adapter implements.
 *
 * Strategies and agents are written against this, never against a specific
 * venue, so the same mandate can route to Kuru (spot) or Perpl (perps) without
 * the strategy knowing which. Adapters live in their own packages; this one
 * carries the contract and nothing else.
 *
 * Contract notes for implementers:
 * - Reads (`getMarkets`, `getDepth`, `getKlines`, `quote`, `getOpenOrders`,
 *   `getBalances`) must never mutate state or sign anything.
 * - Writes (`placeLimit`, `placeMarket`, `cancel`) are the only methods that
 *   sign. Every one of them runs behind a mandate check, so they must be
 *   individually authorizable — never batch two user intents into one call.
 * - Symbols crossing this boundary are canonical Sente symbols. Translate to
 *   the venue's own naming inside the adapter.
 */
export interface Venue {
  /** Stable identifier for this adapter, e.g. `"kuru"` or `"perpl"`. */
  readonly id: string;

  /** Human-readable name for UI. */
  readonly name: string;

  /** Markets this adapter can trade. */
  getMarkets(): Promise<Market[]>;

  /** Current order book. */
  getDepth(query: DepthQuery): Promise<Depth>;

  /** Historical candles, oldest first. */
  getKlines(query: KlineQuery): Promise<Kline[]>;

  /** Simulate an order against the live book. Must not place anything. */
  quote(request: QuoteRequest): Promise<Quote>;

  /** Submit a limit order. */
  placeLimit(request: LimitOrderRequest): Promise<Order>;

  /** Submit a market order. */
  placeMarket(request: MarketOrderRequest): Promise<Order>;

  /** Cancel a resting order. Cancelling an already-terminal order is a no-op. */
  cancel(request: CancelRequest): Promise<Order>;

  /** Orders still working. Optionally narrowed to one market. */
  getOpenOrders(symbol?: MarketSymbol): Promise<Order[]>;

  /** Account balances held at this venue. */
  getBalances(): Promise<Balance[]>;
}

/**
 * Perpetuals extension. Spot venues (Kuru) implement `Venue`; perp venues
 * (Perpl) implement this. Narrow with {@link isPerpsVenue} before reaching for
 * position methods.
 */
export interface PerpsVenue extends Venue {
  readonly kind: 'perps';

  /** Open positions. Optionally narrowed to one market. */
  getPositions(symbol?: MarketSymbol): Promise<Position[]>;

  /**
   * Set leverage for a market. Applies to subsequent orders; whether it also
   * re-margins an open position is venue-specific, so adapters must document
   * their behaviour.
   */
  setLeverage(request: SetLeverageRequest): Promise<Position | void>;

  /**
   * Close a position, fully or partially. Adapters implement this as a
   * reduce-only order so it can never accidentally flip the position.
   */
  closePosition(request: ClosePositionRequest): Promise<Order>;
}

export interface SetLeverageRequest {
  symbol: MarketSymbol;
  /** Target leverage, e.g. `5` for 5x. Clamped to the market's `maxLeverage`. */
  leverage: number;
  marginMode?: MarginMode;
}

export interface ClosePositionRequest {
  symbol: MarketSymbol;
  /** Base units to close. Omit to close the whole position. */
  size?: Decimal;
  /** Worst acceptable execution price when closing at market. */
  slippageLimitPrice?: Decimal;
}

/** Type guard: does this adapter support positions and leverage? */
export function isPerpsVenue(venue: Venue): venue is PerpsVenue {
  return (venue as PerpsVenue).kind === 'perps';
}
