import { KURU_TESTNET_API } from './constants.ts';
export class KuruApiError extends Error {
  status;
  code;
  requestId;
  constructor(message, status, code, requestId) {
    super(message);
    this.name = 'KuruApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}
export function createKuruApi(config = {}) {
  const dataSource = config.dataSourceUrl ?? KURU_TESTNET_API.dataSource;
  const gateway = config.gatewayUrl ?? KURU_TESTNET_API.gateway;
  const doFetch = config.fetch ?? globalThis.fetch;
  async function get(base, path, query = {}) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await doFetch(url, { headers: { accept: 'application/json' } });
    let body;
    try {
      body = await response.json();
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
    markets: () => get(dataSource, '/api/v1/markets', { status: 'active', limit: 500 }),
    /** Finalized OHLCV. `from` and `to` are Unix SECONDS, inclusive, on candle start. */
    candles: (market, query) =>
      get(dataSource, `/api/v1/markets/${market.toLowerCase()}/candles`, query),
    /** Aggregated book by Kuru symbol (`MONUSDC`), up to 200 levels a side. */
    depth: (venueSymbol, levels, state = 'finalized') =>
      get(gateway, '/api/depth', { symbol: venueSymbol, levels, state }),
    /** An account's resting orders across every market, capped at 2,000. */
    userOrders: (userId, state = 'proposed') =>
      get(gateway, `/api/v1/users/${userId}/orders`, { state }),
    /** An account's finalized order history on one market, newest first. First page only. */
    orderEvents: (userId, market, limit = 500) =>
      get(dataSource, `/api/v1/users/${userId}/order-events`, {
        marketAddress: market.toLowerCase(),
        limit,
      }),
  };
}
