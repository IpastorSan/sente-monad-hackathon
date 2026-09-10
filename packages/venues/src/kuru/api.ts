/**
 * Kuru's testnet read APIs: the Data Source (finalized catalog and candles) and
 * the Exchange Gateway (current projected book and user snapshots).
 *
 * Both are read-only — there is no order-entry route on either. Placement is a
 * contract call; see `orders.ts`.
 *
 * Wire types mirror the documented JSON exactly, integers-as-strings included,
 * and `mapping.ts` converts them. Nothing here turns a quantity into a JS
 * number.
 */
import type { Address } from 'viem';

import { KURU_TESTNET_API } from './constants.ts';

export type ApiToken = {
  readonly tokenAddress: string;
  readonly symbol: string;
  readonly decimals: number;
};

export type ApiMarket = {
  readonly marketAddress: string;
  readonly symbol: string;
  readonly baseToken: ApiToken;
  readonly quoteToken: ApiToken;
  readonly status: 'active' | 'paused';
  /** Book price units per 1 quote-per-base, e.g. `"1000000"`. */
  readonly pricePrecision: string;
  /** Book size units per 1 base. */
  readonly sizePrecision: string;
  /** In book price units. */
  readonly tickSize: string;
  /** Minimum order notional in quote units, scaled by 1e18. */
  readonly minQuoteNotionalX18: string;
  readonly takerFeePps: number;
  readonly makerFeePps: number;
};

export type ApiBookLevel = {
  /** Book price units. */
  readonly price: string;
  /** Book size units. */
  readonly total_base: string;
};

export type ApiDepth = {
  readonly symbol: string;
  readonly market_id: string;
  readonly market_seq: number;
  readonly bids: readonly ApiBookLevel[];
  readonly asks: readonly ApiBookLevel[];
};

/** Columnar: index `i` across every array is one candle. Oldest first. */
export type ApiCandles = {
  /** Candle start, Unix SECONDS. */
  readonly t: readonly number[];
  /** Book price units. */
  readonly o: readonly string[];
  readonly h: readonly string[];
  readonly l: readonly string[];
  readonly c: readonly string[];
  /** Quote volume scaled by 1e18. There is no base-volume column. */
  readonly v: readonly string[];
};

export type ApiOpenOrder = {
  readonly orderId: string;
  readonly marketAddress: string;
  readonly slotIdx: number;
  readonly symbol: string | null;
  readonly isBuy: boolean;
  /** Book price units. */
  readonly price: string;
  /** Book size units. The snapshot does not carry the original size. */
  readonly remainingSize: string;
  readonly minSizeAfterBlock: number | null;
  readonly clientOrderId: string | null;
};

/**
 * One entry of an account's finalized order history. There is no fill event:
 * an order that was `created`, never `cancelled`, and no longer rests was
 * filled.
 */
export type ApiOrderEvent = {
  readonly eventKind: 'created' | 'cancelled' | 'rab_reduced';
  readonly orderId: string;
  readonly marketAddress: string;
  readonly isBuy: boolean;
  /** Book price units. */
  readonly price: string;
  /** Initial size for `created`, removed size for `cancelled`, `null` for `rab_reduced`. */
  readonly size: string | null;
  readonly clientOrderId: string | null;
  /** Unix milliseconds. */
  readonly blockTimestamp: number;
  readonly transactionHash: string | null;
};

/** The intervals Kuru materializes. Anything else is aggregated in `mapping.ts`. */
export type CandleInterval = '1s' | '1m' | '5m' | '1h' | '6h' | '1d';

/**
 * Gateway projection views, freshest first. `finalized` is what the Data
 * Source serves; `proposed` is what to read right after submitting.
 */
export type ProjectionState = 'proposed' | 'voted' | 'finalized';

export class KuruApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = 'KuruApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type KuruApiConfig = {
  readonly dataSourceUrl?: string;
  readonly gatewayUrl?: string;
  readonly fetch?: typeof fetch;
};

/** Every response, success or error, shares this envelope. */
type Envelope<T> = {
  readonly data?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly requestId?: string;
};

type Query = Record<string, string | number | undefined>;

export type KuruApi = ReturnType<typeof createKuruApi>;

export function createKuruApi(config: KuruApiConfig = {}) {
  const dataSource = config.dataSourceUrl ?? KURU_TESTNET_API.dataSource;
  const gateway = config.gatewayUrl ?? KURU_TESTNET_API.gateway;
  const doFetch = config.fetch ?? globalThis.fetch;

  async function get<T>(base: string, path: string, query: Query = {}): Promise<T> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await doFetch(url, { headers: { accept: 'application/json' } });
    let body: Envelope<T> | undefined;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      body = undefined;
    }
    if (!response.ok || body?.error || body?.data === undefined) {
      throw new KuruApiError(
        `${url.pathname}: ${body?.error?.message ?? `HTTP ${response.status}`}`,
        response.status,
        body?.error?.code,
        body?.requestId,
      );
    }
    return body.data;
  }

  return {
    /** Active markets with their trading configuration. */
    markets: () =>
      get<readonly ApiMarket[]>(dataSource, '/api/v1/markets', { status: 'active', limit: 500 }),

    /** Finalized OHLCV. `from` and `to` are Unix SECONDS, inclusive, on candle start. */
    candles: (
      market: Address,
      query: { interval: CandleInterval; from: number; to?: number; countback?: number },
    ) => get<ApiCandles>(dataSource, `/api/v1/markets/${market.toLowerCase()}/candles`, query),

    /** Aggregated book by Kuru symbol (`MONUSDC`), up to 200 levels a side. */
    depth: (venueSymbol: string, levels: number, state: ProjectionState = 'finalized') =>
      get<ApiDepth>(gateway, '/api/depth', { symbol: venueSymbol, levels, state }),

    /** An account's resting orders across every market, capped at 2,000. */
    userOrders: (userId: bigint, state: ProjectionState = 'proposed') =>
      get<readonly ApiOpenOrder[]>(gateway, `/api/v1/users/${userId}/orders`, { state }),

    /** An account's finalized order history on one market, newest first. First page only. */
    orderEvents: (userId: bigint, market: Address, limit = 500) =>
      get<readonly ApiOrderEvent[]>(dataSource, `/api/v1/users/${userId}/order-events`, {
        marketAddress: market.toLowerCase(),
        limit,
      }),
  };
}
