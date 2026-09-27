/**
 * HTTP client for `services/api`'s `/markets` routes (SEN-110, plan U-4).
 *
 * The routes are plan B-T6 and may not be deployed yet. An API without them
 * answers Nest's own 404 with no `reason`, which `isUnavailable` reports so a
 * screen can hide its section instead of showing an error (plan-mobile: "an
 * older API answers 404 → not available yet"). A 404 that DOES carry
 * `market_not_found` is a real answer about the market and stays an error.
 *
 * Built like `AgentsApi`: the same session token source, one silent
 * re-authentication on a 401, and the API's `{statusCode, reason, message}`
 * error body surfaced as a typed error. Money stays a decimal string; nothing
 * here converts it.
 */
import { API_URL, type SessionAuth } from '../wallet/api.ts';

// ---------------------------------------------------------------------------
// Wire contract. Copied verbatim from `services/api/src/venues/dto/markets.dto.ts`
// (SEN-70), itself plan-backend's "Wire contract" section. Change these only
// together with that file, or the app and the API disagree silently.
// ---------------------------------------------------------------------------

export type Decimal = string; // exact decimal, never a float
export type VenueId = 'kuru' | 'perpl';
export type QuoteCurrency = 'USDC' | 'AUSD'; // Kuru Testnet USDC vs Agora AUSD — never interchangeable
export interface ApiError {
  statusCode: number;
  reason: string;
  message: string;
  retryAfterMs?: number;
}

// GET /markets
export interface MarketDto {
  venue: VenueId;
  symbol: string;
  venueSymbol: string;
  kind: 'spot' | 'perp';
  base: string;
  quote: QuoteCurrency;
  tickSize: Decimal;
  stepSize: Decimal;
  minSize: Decimal;
  minNotional: Decimal | null; // Kuru only (quote units)
  maxLeverage: number | null; // perps only
  marginMode: 'isolated' | null;
  makerFee: Decimal;
  takerFee: Decimal; // fractions: '0.0007' = 7 bps
}
export interface MarketsResponseDto {
  markets: MarketDto[];
  venues: { venue: VenueId; ok: boolean; error?: string }[]; // partial when a venue is down
  asOf: number;
}

// GET /markets/tickers?venue=  and  GET /markets/:venue/:symbol/ticker
export interface TickerDto {
  venue: VenueId;
  symbol: string;
  quote: QuoteCurrency;
  last: Decimal | null;
  mark: Decimal | null;
  index: Decimal | null; // mark/index: perps
  bid: Decimal | null;
  ask: Decimal | null;
  mid: Decimal | null;
  open24h: Decimal | null;
  high24h: Decimal | null;
  low24h: Decimal | null;
  change24h: Decimal | null;
  change24hPct: Decimal | null; // pct as a fraction
  quoteVolume24h: Decimal | null;
  funding: { rate: Decimal; intervalHours: number; nextAt: number | null } | null; // null until wired from /pub/context (SEN-62)
  stale: boolean;
  asOf: number;
}
export interface TickersResponseDto {
  tickers: TickerDto[];
  asOf: number;
}

// GET /markets/:venue/:symbol/depth?limit=20  (1..50)
export interface DepthDto {
  venue: VenueId;
  symbol: string;
  bids: { price: Decimal; size: Decimal }[]; // best first
  asks: { price: Decimal; size: Decimal }[];
  sequence: number | null;
  stale: boolean;
  asOf: number;
}

// GET /markets/:venue/:symbol/klines?interval=1h&limit=200&endTime=
export type KlineInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'; // perpl: no '1w'
export interface KlineDto {
  openTime: number;
  closeTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal; // base units — an estimate on both venues
  quoteVolume: Decimal | null;
}
export interface KlinesDto {
  venue: VenueId;
  symbol: string;
  interval: KlineInterval;
  klines: KlineDto[]; // oldest first
  volumeIsEstimate: true;
  asOf: number;
}

// GET /markets/:venue/:symbol/quote?side=buy&size=1.5&maxSlippage=0.005
export interface QuoteDto {
  venue: VenueId;
  symbol: string;
  side: 'buy' | 'sell';
  size: Decimal;
  fillableSize: Decimal;
  averagePrice: Decimal | null;
  notional: Decimal;
  estimatedFee: Decimal;
  feeAsset: QuoteCurrency;
  slippageVsMid: Decimal;
  maxSlippage: Decimal; // effective (Perpl clamps to venue bps)
  worstPrice: Decimal | null; // pass as slippageLimitPrice when placing
  fillableWithinWorstPrice: Decimal;
  partial: boolean; // fillableWithinWorstPrice < size → "filled 62%, rest cancelled"
  minNotionalOk: boolean | null; // Kuru only
  bookAsOf: number;
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** A non-2xx response, carrying the API's stable `reason` when it sent one. */
export class MarketsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  /** Sent with 503 `venue_unavailable`: when asking again is worth it. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, reason: string | undefined, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'MarketsApiError';
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The API does not serve this route at all (it predates B-T6): Nest's own 404,
 * which carries no `reason`. Anything else, `market_not_found` included, is a
 * real answer.
 */
export function isUnavailable(error: unknown): boolean {
  return error instanceof MarketsApiError && error.status === 404 && error.reason === undefined;
}

export type MarketsApiOptions = {
  /** The same session token source `AgentsApi` and `WalletApi` send. */
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type KlinesQuery = { interval: KlineInterval; limit?: number; endTime?: number };
export type QuoteQuery = { side: 'buy' | 'sell'; size: Decimal; maxSlippage?: Decimal };

type Query = Record<string, string | number | undefined>;

export class MarketsApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  constructor({ auth, baseUrl = API_URL, fetchImpl = fetch }: MarketsApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** `GET /markets` — both venues merged; `venues` says which one is down. */
  markets(): Promise<MarketsResponseDto> {
    return this.request('/markets');
  }

  /** `GET /markets/tickers?venue=` — every market's ticker, or one venue's. */
  tickers(venue?: VenueId): Promise<TickersResponseDto> {
    return this.request('/markets/tickers', { venue });
  }

  /** `GET /markets/:venue/:symbol/ticker` */
  ticker(venue: VenueId, symbol: string): Promise<TickerDto> {
    return this.request(`${marketPath(venue, symbol)}/ticker`);
  }

  /** `GET /markets/:venue/:symbol/depth?limit=` — the API accepts 1..50, default 20. */
  depth(venue: VenueId, symbol: string, limit?: number): Promise<DepthDto> {
    return this.request(`${marketPath(venue, symbol)}/depth`, { limit });
  }

  /** `GET /markets/:venue/:symbol/klines?interval=&limit=&endTime=` — oldest first. */
  klines(venue: VenueId, symbol: string, query: KlinesQuery): Promise<KlinesDto> {
    return this.request(`${marketPath(venue, symbol)}/klines`, query);
  }

  /** `GET /markets/:venue/:symbol/quote?side=&size=&maxSlippage=` — a read, never an order. */
  quote(venue: VenueId, symbol: string, query: QuoteQuery): Promise<QuoteDto> {
    return this.request(`${marketPath(venue, symbol)}/quote`, query);
  }

  /** One request, and at most one silent re-authentication — see `WalletApi`. */
  private async request<T>(path: string, query?: Query): Promise<T> {
    const url = `${this.baseUrl}${path}${queryString(query)}`;
    const first = await this.send(url, this.auth.token());
    if (first.status !== 401) return this.read<T>(first);

    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read<T>(first);
    return this.read<T>(await this.send(url, refreshed));
  }

  private send(url: string, token: string | null): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'GET',
      headers: token !== null ? { authorization: `Bearer ${token}` } : {},
    });
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const detail = parsed as
        { reason?: string; message?: string | string[]; retryAfterMs?: unknown } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      const retryAfterMs =
        typeof detail?.retryAfterMs === 'number' ? detail.retryAfterMs : undefined;
      throw new MarketsApiError(response.status, detail?.reason, message, retryAfterMs);
    }
    return parsed as T;
  }
}

/** `symbol` ends up in a path segment, so it is encoded even though the API constrains it. */
function marketPath(venue: VenueId, symbol: string): string {
  return `/markets/${venue}/${encodeURIComponent(symbol)}`;
}

function queryString(query?: Query): string {
  const pairs = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
  if (pairs.length === 0) return '';
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
