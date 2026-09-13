/**
 * In-memory venues for specs: no chain, no Perpl, no network. Every call is
 * recorded, and `onWrite` lets a spec hold a write in flight or make it throw
 * (an `EnclaveRefusedError`, a venue error) the way the real path would.
 */
import type {
  Balance,
  CancelRequest,
  ClosePositionRequest,
  Depth,
  DepthQuery,
  Kline,
  LimitOrderRequest,
  Market,
  MarketOrderRequest,
  Order,
  PerpsVenue,
  Position,
  Quote,
  QuoteRequest,
  SetLeverageRequest,
} from '@sente/venues';
import {
  KURU_TESTNET_MARKETS,
  KuruOrderError,
  type KuruExecution,
  type KuruMarketConfig,
} from '@sente/venues/kuru';

import type { KuruToolVenue, ToolVenues } from '../context';

export interface VenueCall {
  readonly method: string;
  readonly args: unknown;
}

const WRITES = new Set([
  'placeLimit',
  'placeMarket',
  'cancel',
  'deposit',
  'withdraw',
  'closePosition',
  'setLeverage',
]);

abstract class FakeVenue {
  readonly calls: VenueCall[] = [];
  /** Awaited inside every write, after it is recorded. Throw to fail it. */
  onWrite: ((method: string, args: unknown) => Promise<void>) | undefined;
  /** What `quote` reports as the book's average price. */
  quotePrice = '1';
  /** What `getBalances` reports (Kuru: AccountCore). Plenty by default, so pre-flight passes. */
  balances: Balance[] = [
    { asset: 'USDC', available: '100000', locked: '0', total: '100000' },
    { asset: 'MON', available: '100000', locked: '0', total: '100000' },
  ];
  /** What `getMarkets` reports; empty means no minimum notional is known. */
  markets: Market[] = [];
  private sequence = 0;

  /** Only the calls that would sign or trade. */
  writes(): VenueCall[] {
    return this.calls.filter((c) => WRITES.has(c.method));
  }

  protected record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  protected async write(method: string, args: unknown): Promise<void> {
    this.record(method, args);
    await this.onWrite?.(method, args);
  }

  protected order(
    request: { symbol: string; side: 'buy' | 'sell'; size: string },
    type: 'limit' | 'market',
    price: string | undefined,
  ): Order {
    const now = Date.now();
    const filled = type === 'market';
    return {
      id: `order-${++this.sequence}`,
      symbol: request.symbol,
      side: request.side,
      type,
      status: filled ? 'filled' : 'open',
      price,
      size: request.size,
      filledSize: filled ? request.size : '0',
      averageFillPrice: filled ? price : undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  getMarkets(): Promise<Market[]> {
    this.record('getMarkets', undefined);
    return Promise.resolve(this.markets);
  }

  getDepth(query: DepthQuery): Promise<Depth> {
    this.record('getDepth', query);
    return Promise.resolve({ symbol: query.symbol, bids: [], asks: [], timestamp: Date.now() });
  }

  getKlines(): Promise<Kline[]> {
    return Promise.resolve([]);
  }

  quote(request: QuoteRequest): Promise<Quote> {
    this.record('quote', request);
    return Promise.resolve({
      ...request,
      fillableSize: request.size,
      averagePrice: this.quotePrice,
      notional: '0',
      slippage: '0',
      timestamp: Date.now(),
    });
  }

  async placeLimit(request: LimitOrderRequest): Promise<Order> {
    await this.write('placeLimit', request);
    return this.order(request, 'limit', request.price);
  }

  async placeMarket(request: MarketOrderRequest): Promise<Order> {
    await this.write('placeMarket', request);
    return this.order(request, 'market', request.slippageLimitPrice);
  }

  async cancel(request: CancelRequest): Promise<Order> {
    await this.write('cancel', request);
    const now = Date.now();
    return {
      id: request.orderId,
      symbol: request.symbol,
      side: 'buy',
      type: 'limit',
      status: 'cancelled',
      size: '1',
      filledSize: '0',
      createdAt: now,
      updatedAt: now,
    };
  }

  getOpenOrders(): Promise<Order[]> {
    this.record('getOpenOrders', undefined);
    return Promise.resolve([]);
  }

  getBalances(): Promise<Balance[]> {
    this.record('getBalances', undefined);
    return Promise.resolve(this.balances);
  }
}

export class FakeKuruVenue extends FakeVenue implements KuruToolVenue {
  readonly id = 'kuru';
  readonly name = 'Kuru (fake)';
  /** What `walletBalances` reports: the wallet, outside AccountCore. */
  wallet: Balance[] = [
    { asset: 'USDC', available: '100000', locked: '0', total: '100000' },
    { asset: 'MON', available: '100000', locked: '0', total: '100000' },
  ];

  walletBalances(): Promise<Balance[]> {
    this.record('walletBalances', undefined);
    return Promise.resolve(this.wallet);
  }

  market(symbol: string): KuruMarketConfig {
    const market = KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol);
    if (!market) throw new KuruOrderError(`Kuru does not list ${symbol}`);
    return market;
  }

  async deposit(asset: string, amount: string): Promise<KuruExecution> {
    await this.write('deposit', { asset, amount });
    return {
      hash: `0x${'d'.repeat(64)}`,
      transactionHash: `0x${'d'.repeat(64)}`,
      success: true,
      logs: [],
    };
  }

  async withdraw(asset: string, amount: string): Promise<KuruExecution> {
    await this.write('withdraw', { asset, amount });
    return {
      hash: `0x${'e'.repeat(64)}`,
      transactionHash: `0x${'e'.repeat(64)}`,
      success: true,
      logs: [],
    };
  }
}

export class FakePerplVenue extends FakeVenue implements PerpsVenue {
  readonly id = 'perpl';
  readonly name = 'Perpl (fake)';
  readonly kind = 'perps' as const;

  getPositions(): Promise<Position[]> {
    this.record('getPositions', undefined);
    return Promise.resolve([]);
  }

  async setLeverage(request: SetLeverageRequest): Promise<void> {
    await this.write('setLeverage', request);
  }

  async closePosition(request: ClosePositionRequest): Promise<Order> {
    await this.write('closePosition', request);
    return this.order(
      { symbol: request.symbol, side: 'sell', size: request.size ?? '1' },
      'market',
      request.slippageLimitPrice,
    );
  }
}

export function fakeVenues(options: { perpl?: boolean } = {}): {
  kuru: FakeKuruVenue;
  perpl: FakePerplVenue;
  venues: ToolVenues;
} {
  const kuru = new FakeKuruVenue();
  const perpl = new FakePerplVenue();
  return { kuru, perpl, venues: options.perpl === false ? { kuru } : { kuru, perpl } };
}
