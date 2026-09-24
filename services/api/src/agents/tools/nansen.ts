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
 *   for 10 minutes per endpoint+body, a failing fetch is cached too (otherwise
 *   a broken key burns credits on every tool call), and callers are deduped
 *   through an in-flight map so a parallel run costs one call, not two. Since
 *   SEN-49 neither request body mentions the market, so that cache entry is
 *   shared by every market: two credits per ten minutes, however many markets
 *   the model asks about.
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
/** One Monad netflow page, matched client-side — see NETFLOW_FILTERS below. */
const NETFLOW_PAGE = 100;

// ---------------------------------------------------------------------------
// Market → token
//
// SEN-49. The netflow request carries NO token filter and rows are matched
// client-side on the token's mainnet CONTRACT ADDRESS. Measured against the
// live API on 2026-09-24, because the docs and the server disagree:
//
//   - `docs.nansen.ai/api/smart-money/netflows` documents
//     `filters.token_address` as "Token address or symbol filter".
//   - A symbol is rejected: `{"token_address":"MON"}` → HTTP 422
//     `Invalid address format: MON`. So it is an address field, not a symbol
//     one, and SEN-29's `token.symbol` could never have worked.
//   - But an address does not work either. An unfiltered `chains:["ethereum"]`
//     page returns WETH at `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`;
//     re-asking with exactly that value in `filters.token_address` — as a
//     string, and as a one-element array, checksummed and lowercase — returns
//     HTTP 200 with `data: []`. The filter validates the format and then
//     matches nothing, silently.
//
// So the only usable contract is: don't filter, take one page for the chain,
// and match rows ourselves. Two things follow, both good:
//
//   - the request body no longer depends on the market, so every market shares
//     one cache entry and netflow costs ONE credit per 10 minutes, not one per
//     market (dex-trades was already market-independent);
//   - matching on address rather than symbol cannot be fooled by a same-named
//     impostor token, which is exactly what a smart-money read must not be.
//
// Nansen returns `token_address` LOWERCASE, so every address below is stored
// lowercase and compared lowercase.
// ---------------------------------------------------------------------------

/**
 * `include_native_tokens` / `include_stablecoins` default to `false` and
 * netflow has no working token filter, so both are on: MON is native, and a
 * stablecoin-based market must still be matchable.
 */
const NETFLOW_FILTERS = { include_native_tokens: true, include_stablecoins: true } as const;

export interface NansenToken {
  /** Display name, and the fallback row match for a base we have no address for. */
  readonly symbol: string;
  /**
   * Monad **mainnet** contract addresses this token may appear under,
   * lowercase. Empty for a base we have no verified address for; then rows are
   * matched by symbol and the answer is only as trustworthy as that name.
   */
  readonly addresses: readonly string[];
  /** True for Monad's native asset; kept so the reading can say so. */
  readonly native: boolean;
}

// Monad MAINNET (chain id 143) addresses. Source for every one of them: the
// official token list, github.com/monad-crypto/token-list,
// `tokenlist-mainnet.json` at commit 20779d2ccf0e5d305d3790a21dcef4cb73342c60
// (2026-09-21), cross-checked on monadscan.com as noted per line.
// Do not edit one of these from memory — re-read the token list.

/** Native MON. The token list gives the zero address for the native asset. */
const MON_NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Wrapped MON, the ERC-20 form smart money actually trades on a DEX. */
const WMON_ADDRESS = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
/** Wrapped Ether — monadscan.com/token/0xee8c0e9f1bffb4eb878d8f15f368a02a35481242 */
const WETH_ADDRESS = '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242';
/** Coinbase Wrapped BTC — monadscan.com/token/0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b */
const CBBTC_ADDRESS = '0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b';
/** XAUt0, the omnichain Tether Gold on Monad (there is no plain "XAUt" here) —
 *  monadscan.com/token/0x01bff41798a0bcf287b996046ca68b395dbc1071 */
const XAUT0_ADDRESS = '0x01bff41798a0bcf287b996046ca68b395dbc1071';

/**
 * The token behind each base symbol we actually trade, as a mainnet proxy:
 * BTC exposure on our venues maps to cbBTC (Coinbase's wrapped BTC on Monad),
 * ETH to WETH, gold to XAUt0. Anything else is matched by its own name and
 * reports `no_data` if Nansen has nothing for it.
 */
const BASE_TO_TOKEN: Readonly<Record<string, NansenToken>> = {
  // Native and wrapped MON are the same exposure, so either row answers.
  MON: { symbol: 'MON', addresses: [MON_NATIVE_ADDRESS, WMON_ADDRESS], native: true },
  WMON: { symbol: 'WMON', addresses: [WMON_ADDRESS, MON_NATIVE_ADDRESS], native: false },
  WETH: { symbol: 'WETH', addresses: [WETH_ADDRESS], native: false },
  ETH: { symbol: 'WETH', addresses: [WETH_ADDRESS], native: false },
  cbBTC: { symbol: 'cbBTC', addresses: [CBBTC_ADDRESS], native: false },
  BTC: { symbol: 'cbBTC', addresses: [CBBTC_ADDRESS], native: false },
  XAUt: { symbol: 'XAUt0', addresses: [XAUT0_ADDRESS], native: false },
  XAUt0: { symbol: 'XAUt0', addresses: [XAUT0_ADDRESS], native: false },
  PAXG: { symbol: 'XAUt0', addresses: [XAUT0_ADDRESS], native: false },
};

/**
 * `'MON-USDC' → the MON entry`. A base we do not know gets an addressless
 * token: it is matched by symbol, which is weaker, and says so in `matchedBy`.
 */
export function tokenForMarket(market: string): NansenToken {
  const base = market.split(/[-_]/)[0] ?? market;
  const known = Object.entries(BASE_TO_TOKEN).find(
    ([key]) => key.toLowerCase() === base.toLowerCase(),
  );
  if (known) return known[1];
  return { symbol: base, addresses: [], native: base.toUpperCase() === 'MON' };
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
  /** Lowercase contract address; the zero address for a native asset. */
  token_address?: string;
  token_symbol?: string;
  net_flow_1h_usd?: number;
  net_flow_24h_usd?: number;
  /** Smart-money wallets that traded this token in the past 30 days. */
  trader_count?: number;
}

interface DexTradeRecord {
  /** Lowercase contract addresses; preferred over the symbols for matching. */
  token_bought_address?: string;
  token_sold_address?: string;
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

  /**
   * One page of Monad smart-money netflow, **unfiltered by token** — the
   * `filters.token_address` filter rejects a symbol with 422 and silently
   * matches nothing when given an address (SEN-49; see the note above
   * `NETFLOW_FILTERS`). Callers match the token they want over these rows, so
   * the body is the same for every market and one credit serves them all.
   */
  netflow(): Promise<EndpointResult<NetflowRecord>> {
    return this.#call<NetflowRecord>(NETFLOW_PATH, {
      chains: [NANSEN_CHAIN],
      filters: NETFLOW_FILTERS,
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
      /**
       * How rows were tied to the token: by mainnet contract `address`, which
       * an impostor token cannot fake, or by `symbol`, which it can.
       */
      matchedBy: 'address' | 'symbol';
      /**
       * Set when one of the two endpoints failed and the other still answered:
       * its half of the summary is `null`. Both failing is `unavailable`.
       */
      degraded: { endpoint: 'netflow' | 'dex-trades'; message: string } | null;
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
  const [netflow, trades] = await Promise.all([client.netflow(), client.dexTrades()]);

  const unavailable = (partial: 'netflow' | 'dex-trades' | 'both'): SmartMoneySignals => ({
    status: 'unavailable',
    source: 'nansen',
    market,
    token: token.symbol,
    partial,
    message:
      `Nansen ${partial} unavailable (${failureMessage(netflow, trades)}). ` +
      'Treat it as no signal; do not retry more than once.',
  });

  // Neither endpoint answered: there is nothing to report but the failure.
  if (!netflow.ok && !trades.ok) return unavailable('both');

  // Rows are tied to the token by its mainnet CONTRACT ADDRESS wherever we have
  // a verified one (SEN-49); a base we have no address for falls back to the
  // symbol, which a same-named impostor token could satisfy.
  const record = netflow.rows.find((r) => matchesToken(token, r.token_address, r.token_symbol));
  const relevant = trades.rows.filter(
    (t) =>
      matchesToken(token, t.token_bought_address, t.token_bought_symbol) ||
      matchesToken(token, t.token_sold_address, t.token_sold_symbol),
  );

  // One endpoint failed. Half a summary beats none (SEN-49: a 422 on netflow
  // used to throw away a perfectly good dex-trades read) — but only if that
  // half carries a signal.
  const failed = netflow.ok ? (trades.ok ? undefined : 'dex-trades') : 'netflow';

  if (!record && relevant.length === 0) {
    // Nothing found. With an endpoint down, "no data" would be a claim about
    // the endpoint that never answered, so report the failure instead.
    if (failed) return unavailable(failed);
    return {
      status: 'no_data',
      source: 'nansen',
      market,
      token: token.symbol,
      network: 'mainnet',
      message:
        `Nansen has no smart-money data for ${token.symbol} on ${NANSEN_CHAIN} mainnet right now. ` +
        'That is a real absence of activity for this page, not a failure.' +
        (netflow.truncated
          ? ' The netflow page did not cover every token on the chain, so treat it as "not on this page".'
          : ''),
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
    if (matchesToken(token, trade.token_bought_address, trade.token_bought_symbol)) {
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
    matchedBy: token.addresses.length > 0 ? 'address' : 'symbol',
    degraded: failed ? { endpoint: failed, message: failureMessage(netflow, trades) } : null,
    fetchedAt: new Date(client.nowMs()).toISOString(),
    flow24h,
    dexTrades24h: trades.ok
      ? {
          buys,
          sells,
          buyUsd: round2(buyUsd),
          sellUsd: round2(sellUsd),
          wallets: wallets.size,
          pageTruncated: trades.truncated,
        }
      : null,
  };
}

/** The failing endpoint's message — for 'both', netflow's stands for the pair. */
function failureMessage(netflow: EndpointResult<unknown>, trades: EndpointResult<unknown>): string {
  return (netflow.ok ? trades.message : netflow.message) ?? 'Nansen request failed';
}

/**
 * Does this row describe our token? By contract address when we have verified
 * ones — the only match a same-named impostor cannot satisfy — and by symbol
 * only for a base whose mainnet address we do not know.
 */
function matchesToken(
  token: NansenToken,
  rowAddress: string | undefined,
  rowSymbol: string | undefined,
): boolean {
  if (token.addresses.length > 0) {
    return rowAddress !== undefined && token.addresses.includes(rowAddress.toLowerCase());
  }
  return rowSymbol !== undefined && rowSymbol.toLowerCase() === token.symbol.toLowerCase();
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
