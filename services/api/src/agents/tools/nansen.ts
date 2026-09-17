/**
 * Nansen smart-money read client (SEN-29).
 *
 * Gives agents a *decision input*, not a data feed: one compact summary of what
 * Nansen's Smart Money cohort is doing to the token behind a market — 24 h net
 * flow in USD, its direction, how many smart wallets traded it, and the last
 * 24 h of their DEX buys vs sells.
 *
 * Two facts shape the whole file:
 *
 * - Nansen covers Monad **mainnet** only (data from 14 May 2025; there is no
 *   testnet coverage). Our agents trade on Kuru/Perpl **testnet**, so this is
 *   context about the real market, never a mirror of the venue's book. The
 *   result says so in its `network` and `reading` fields.
 * - The free API plan is 100 credits, then ~10 a day. Every response is cached
 *   for 10 minutes per endpoint+token, a failing fetch is cached too (otherwise
 *   a broken key burns credits on every tool call), and callers are deduped
 *   through an in-flight map so a parallel run costs one call, not two.
 *
 * Authentication is Nansen's `apikey` header (`docs.nansen.ai/getting-started/
 * authentication`), from `NANSEN_API_KEY`. The key never appears in a result:
 * errors come back redacted, one line, like every other tool message.
 *
 * Endpoints (POST, JSON body — see docs/nansen.md):
 * - `https://api.nansen.ai/api/v1/smart-money/netflow`
 * - `https://api.nansen.ai/api/v1/smart-money/dex-trades` (trailing 24 h only)
 */

const NANSEN_API_BASE = 'https://api.nansen.ai';
const NETFLOW_PATH = '/api/v1/smart-money/netflow';
const DEX_TRADES_PATH = '/api/v1/smart-money/dex-trades';

/** Nansen's chain slug for Monad mainnet — the only Monad they index. */
export const NANSEN_CHAIN = 'monad';

/** Free plan is 100 credits then ~10/day; 10 minutes keeps one run to two calls. */
export const NANSEN_CACHE_TTL_MS = 10 * 60 * 1000;

/** Trailing-24 h trades are paginated; this many per call bounds the credit cost. */
const DEX_TRADES_PAGE = 200;
/** Netflow rows after the token filter; room for the symbol matching to work on. */
const NETFLOW_PAGE = 100;

// ---------------------------------------------------------------------------
// Market → token
//
// Nansen's netflow `token_address` filter accepts a token *symbol*, so these
// are the query terms, not addresses. MON is Monad's native asset; netflow
// hides native tokens unless `include_native_tokens` says otherwise.
// ---------------------------------------------------------------------------

export interface NansenToken {
  readonly symbol: string;
  readonly native: boolean;
}

/**
 * The token behind each base symbol we actually trade, as a mainnet proxy:
 * BTC exposure on our venues maps to cbBTC (Coinbase's wrapped BTC on Monad),
 * ETH to WETH. Anything else is queried under its own name and reports
 * `no_data` if Nansen has nothing for it.
 */
const BASE_TO_TOKEN: Readonly<Record<string, NansenToken>> = {
  MON: { symbol: 'MON', native: true },
  WETH: { symbol: 'WETH', native: false },
  ETH: { symbol: 'WETH', native: false },
  cbBTC: { symbol: 'cbBTC', native: false },
  BTC: { symbol: 'cbBTC', native: false },
  XAUt: { symbol: 'XAUt', native: false },
  PAXG: { symbol: 'XAUt', native: false },
};

/** `'MON-USDC' → { symbol: 'MON', native: true }`. Unknown bases query their own name. */
export function tokenForMarket(market: string): NansenToken {
  const base = market.split(/[-_]/)[0] ?? market;
  const known = Object.entries(BASE_TO_TOKEN).find(
    ([key]) => key.toLowerCase() === base.toLowerCase(),
  );
  return known ? known[1] : { symbol: base, native: base.toUpperCase() === 'MON' };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface NansenClientOptions {
  /** Defaults to `process.env.NANSEN_API_KEY`, trimmed; empty means not configured. */
  apiKey?: string | undefined;
  /** Override for tests or a proxy. Defaults to {@link NANSEN_API_BASE}. */
  baseUrl?: string | undefined;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Unix ms, injectable so the cache TTL is testable without waiting. */
  now?: (() => number) | undefined;
}

/** Raw API record shapes, narrowed to the fields we read (see docs/nansen.md). */
interface NetflowRecord {
  token_symbol?: string;
  net_flow_1h_usd?: number;
  net_flow_24h_usd?: number;
  /** Smart-money wallets that traded this token in the past 30 days. */
  trader_count?: number;
}

interface DexTradeRecord {
  token_bought_symbol?: string;
  token_sold_symbol?: string;
  trader_address?: string;
  trade_value_usd?: number | null;
}

interface PagedBody<T> {
  data?: T[];
  pagination?: { is_last_page?: boolean };
}

type Cached =
  { ok: true; body: PagedBody<unknown> } | { ok: false; status: number; message: string };

/** One endpoint's rows, or the reason the endpoint was unusable. */
export interface EndpointResult<T> {
  readonly ok: boolean;
  readonly rows: T[];
  readonly truncated: boolean;
  readonly status: number;
  readonly message: string | undefined;
}

export class NansenClient {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  #fetch: typeof globalThis.fetch | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, { expiresAt: number; value: Cached }>();
  readonly #inFlight = new Map<string, Promise<Cached>>();

  constructor(options: NansenClientOptions = {}) {
    this.#apiKey = (options.apiKey ?? process.env['NANSEN_API_KEY'] ?? '').trim() || undefined;
    this.#baseUrl = (options.baseUrl ?? NANSEN_API_BASE).replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Resolved per call, so a spec can stub `globalThis.fetch` after construction. */
  get fetchFn(): typeof globalThis.fetch {
    return this.#fetch ?? globalThis.fetch;
  }

  /** False when no key is configured; callers must not treat that as an error. */
  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  /** Unix ms from the client's own clock, so cached results stamp honestly. */
  nowMs(): number {
    return this.#now();
  }

  netflow(token: NansenToken): Promise<EndpointResult<NetflowRecord>> {
    return this.#call<NetflowRecord>(NETFLOW_PATH, {
      chains: [NANSEN_CHAIN],
      filters: {
        token_address: token.symbol,
        include_native_tokens: token.native,
      },
      pagination: { page: 1, per_page: NETFLOW_PAGE },
    });
  }

  /**
   * Trailing 24 h of smart-money DEX trades on Monad, biggest first. Nansen
   * has no OR filter across bought/sold, so the token match happens client-side
   * over this page; `truncated` says when the page was not the whole 24 h.
   */
  dexTrades(): Promise<EndpointResult<DexTradeRecord>> {
    return this.#call<DexTradeRecord>(DEX_TRADES_PATH, {
      chains: [NANSEN_CHAIN],
      pagination: { page: 1, per_page: DEX_TRADES_PAGE },
      order_by: [{ field: 'trade_value_usd', direction: 'DESC' }],
    });
  }

  async #call<T>(path: string, body: Record<string, unknown>): Promise<EndpointResult<T>> {
    if (!this.configured) {
      return { ok: false, rows: [], truncated: false, status: 0, message: 'not_configured' };
    }
    const key = `${path} ${JSON.stringify(body)}`;
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) {
      return toEndpointResult<T>(cached.value);
    }
    // Deduped through in-flight: two tools in one run fetch each endpoint once.
    let pending = this.#inFlight.get(key);
    if (!pending) {
      pending = this.#fetchOnce(path, body).then((value) => {
        // Failures are cached for the same TTL: a dead key must not spend a
        // credit on every call the model makes.
        this.#cache.set(key, { expiresAt: this.#now() + NANSEN_CACHE_TTL_MS, value });
        this.#inFlight.delete(key);
        return value;
      });
      this.#inFlight.set(key, pending);
    }
    return toEndpointResult<T>(await pending);
  }

  async #fetchOnce(path: string, body: Record<string, unknown>): Promise<Cached> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.#apiKey as string,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, status: 0, message: `network error: ${errorDetail(error)}` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await nansenErrorMessage(response) };
    }
    try {
      return { ok: true, body: (await response.json()) as PagedBody<unknown> };
    } catch {
      return { ok: false, status: response.status, message: 'malformed response from Nansen' };
    }
  }
}

function toEndpointResult<T>(cached: Cached): EndpointResult<T> {
  if (!cached.ok) {
    return {
      ok: false,
      rows: [],
      truncated: false,
      status: cached.status,
      message: cached.message,
    };
  }
  const body = cached.body;
  return {
    ok: true,
    rows: (Array.isArray(body.data) ? body.data : []) as T[],
    truncated: body.pagination?.is_last_page === false,
    status: 200,
    message: undefined,
  };
}

/** The error's own first line, truncated. The key lives in a header, never here. */
function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] || 'unknown').slice(0, 200);
}

/** Nansen's error envelope has a `message`; keep one line, never our request. */
async function nansenErrorMessage(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const json = (await response.json()) as { message?: unknown; error?: unknown };
    const message = typeof json.message === 'string' ? json.message : undefined;
    if (message) detail = `${response.status}: ${message}`;
  } catch {
    /* the status line is enough */
  }
  return detail.split('\n')[0]!.slice(0, 200);
}

// ---------------------------------------------------------------------------
// The summary the agent reads
// ---------------------------------------------------------------------------

export type FlowDirection = 'accumulating' | 'distributing' | 'flat';

/** Anything below this over 24 h is noise, not a direction. */
const FLAT_THRESHOLD_USD = 1_000;

export type SmartMoneySignals =
  | {
      status: 'not_configured';
      source: 'nansen';
      message: string;
    }
  | {
      status: 'unavailable';
      source: 'nansen';
      market: string;
      token: string;
      /** Which of the two endpoints failed, when only one did. */
      partial: 'netflow' | 'dex-trades' | 'both';
      message: string;
    }
  | {
      status: 'no_data';
      source: 'nansen';
      market: string;
      token: string;
      network: 'mainnet';
      message: string;
    }
  | {
      status: 'ok';
      source: 'nansen';
      market: string;
      /** The mainnet token this was read for — a proxy, not the testnet contract. */
      token: string;
      chain: typeof NANSEN_CHAIN;
      network: 'mainnet';
      /** What the model must not forget when it cites this. */
      reading: string;
      fetchedAt: string;
      flow24h: {
        netUsd: number;
        net1hUsd: number;
        direction: FlowDirection;
        /** Smart-money wallets that traded the token in the past 30 days. */
        smartMoneyWallets: number;
      } | null;
      dexTrades24h: {
        buys: number;
        sells: number;
        buyUsd: number;
        sellUsd: number;
        wallets: number;
        /** True when Nansen's page held fewer trades than the 24 h window. */
        pageTruncated: boolean;
      } | null;
    };

const NOT_CONFIGURED_MESSAGE =
  'Nansen is not configured (NANSEN_API_KEY is unset), so smart-money data is unavailable. ' +
  'Trade on the venue data you have.';

/**
 * One compact smart-money read for one market, from both endpoints. Never
 * throws: every upstream failure becomes a status the model can act on.
 */
export async function fetchSmartMoneySignals(
  client: NansenClient,
  market: string,
): Promise<SmartMoneySignals> {
  if (!client.configured) {
    return { status: 'not_configured', source: 'nansen', message: NOT_CONFIGURED_MESSAGE };
  }
  const token = tokenForMarket(market);
  const [netflow, trades] = await Promise.all([client.netflow(token), client.dexTrades()]);

  if (!netflow.ok || !trades.ok) {
    const failed = netflow.ok ? 'dex-trades' : trades.ok ? 'netflow' : 'both';
    const message = (netflow.ok ? trades.message : netflow.message) ?? 'Nansen request failed';
    return {
      status: 'unavailable',
      source: 'nansen',
      market,
      token: token.symbol,
      partial: failed,
      message: `Nansen ${failed} unavailable (${message}). Treat it as no signal; do not retry more than once.`,
    };
  }

  // Nansen's netflow filter accepted a symbol, so rows are matched by symbol:
  // we query mainnet by name, never by our testnet contract addresses, which
  // mean nothing to Nansen.
  const record = netflow.rows.find((r) => sameSymbol(r.token_symbol, token.symbol));
  const relevant = trades.rows.filter(
    (t) =>
      sameSymbol(t.token_bought_symbol, token.symbol) ||
      sameSymbol(t.token_sold_symbol, token.symbol),
  );

  if (!record && relevant.length === 0) {
    return {
      status: 'no_data',
      source: 'nansen',
      market,
      token: token.symbol,
      network: 'mainnet',
      message:
        `Nansen has no smart-money data for ${token.symbol} on ${NANSEN_CHAIN} mainnet right now. ` +
        'That is a real absence of activity for this page, not a failure.',
    };
  }

  const flow24h = record
    ? {
        netUsd: numberOrZero(record.net_flow_24h_usd),
        net1hUsd: numberOrZero(record.net_flow_1h_usd),
        direction: directionOf(numberOrZero(record.net_flow_24h_usd)),
        smartMoneyWallets: numberOrZero(record.trader_count),
      }
    : null;

  let buys = 0;
  let sells = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  const wallets = new Set<string>();
  for (const trade of relevant) {
    const usd = numberOrZero(trade.trade_value_usd);
    if (sameSymbol(trade.token_bought_symbol, token.symbol)) {
      buys += 1;
      buyUsd += usd;
    } else {
      sells += 1;
      sellUsd += usd;
    }
    if (trade.trader_address) wallets.add(trade.trader_address.toLowerCase());
  }

  return {
    status: 'ok',
    source: 'nansen',
    market,
    token: token.symbol,
    chain: NANSEN_CHAIN,
    network: 'mainnet',
    reading:
      'Monad MAINNET smart-money data, used as context for your TESTNET trades: it describes ' +
      'the real market, not the venue book you trade on.',
    fetchedAt: new Date(client.nowMs()).toISOString(),
    flow24h,
    dexTrades24h: {
      buys,
      sells,
      buyUsd: round2(buyUsd),
      sellUsd: round2(sellUsd),
      wallets: wallets.size,
      pageTruncated: trades.truncated,
    },
  };
}

function sameSymbol(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function numberOrZero(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function directionOf(netUsd: number): FlowDirection {
  if (netUsd > FLAT_THRESHOLD_USD) return 'accumulating';
  if (netUsd < -FLAT_THRESHOLD_USD) return 'distributing';
  return 'flat';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
