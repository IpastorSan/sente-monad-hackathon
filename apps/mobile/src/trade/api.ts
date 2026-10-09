/**
 * HTTP client for `services/api`'s `/trade` and `/portfolio` routes (SEN-102,
 * plan M-T20).
 *
 * Built like `MarketsApi`: the same session token source, one silent
 * re-authentication on a 401, and the API's `{statusCode, reason, message}`
 * error body surfaced as a typed error. The wire types live in `./types.ts`,
 * shared with the verifiers, so there is one copy of each shape on the phone.
 *
 * `/portfolio` (M-T19, SEN-101) sits behind the same trading flag as `/trade`,
 * so with it off it answers 404 `trading_disabled`. An older API without the
 * route answers Nest's own 404 with no `reason`, which `isUnavailable`
 * reports so a screen hides the section. A 404 that carries
 * `trading_disabled` or `trade_not_found` is a real answer and stays an error.
 *
 * Perpl's account read and key enrollment (`perplAccount`, `enrollPrepare`,
 * `enrollCommit`, SEN-104) answer from `/trade/perpl/*`, behind the same flag.
 *
 * Nothing here verifies what `prepare` or `enrollPrepare` returns. That is
 * `verifyKuru.ts`'s and `verifyPerpl.ts`'s job, and the flows (`flow.ts`) run
 * them before anything is signed.
 */
import type { HistoryRange, ValueHistory } from '../portfolio/history.ts';
import { unboundFetch } from '../platform/fetch.ts';
import { API_URL, type SessionAuth } from '../wallet/api.ts';
import type {
  EnrollCommitRequest,
  EnrollCommitResult,
  EnrollPrepareRequest,
  EnrollPrepareResult,
  PerplAccount,
  PerplEnrollRefusalReason,
  Portfolio,
  PortfolioFills,
  PortfolioVenue,
  PreparedTrade,
  TradeCapabilities,
  TradeIntent,
  TradeRefusalReason,
  TradeView,
} from './types.ts';

/** A non-2xx response, carrying the API's stable `reason` when it sent one. */
export class TradeApiError extends Error {
  readonly status: number;
  /** One of {@link TradeRefusalReason} from `/trade`; anything else passes through as sent. */
  readonly reason: TradeRefusalReason | PerplEnrollRefusalReason | (string & {}) | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'TradeApiError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The API does not serve this route at all: Nest's own 404, which carries no
 * `reason`. `trading_disabled` is a 404 too, but it names itself, so a screen
 * can tell "this build of the API has no portfolio" from "trading is off".
 */
export function isUnavailable(error: unknown): boolean {
  return error instanceof TradeApiError && error.status === 404 && error.reason === undefined;
}

/**
 * Whether the app may offer manual trading (SEN-102). All three must hold:
 * the build opted in (`EXPO_PUBLIC_USER_TRADING=1`), the API says it is on,
 * and the app is on testnet — mainnet trading is out of scope for this plan
 * whatever the server says.
 */
export function isTradingEnabled(input: {
  buildFlag: string | undefined;
  capabilities: TradeCapabilities | null;
  network: 'testnet' | 'mainnet';
}): boolean {
  return (
    input.buildFlag === '1' && input.capabilities?.enabled === true && input.network === 'testnet'
  );
}

/**
 * Whether the app may offer perps from the user's own wallet (SEN-120):
 * trading is on and the API trades Perpl for users. Off, a perp market keeps
 * pointing at an agent.
 */
export function isPerpsEnabled(input: Parameters<typeof isTradingEnabled>[0]): boolean {
  return isTradingEnabled(input) && input.capabilities?.venues.perpl === true;
}

export type TradeApiOptions = {
  /** The same session token source `AgentsApi`, `MarketsApi` and `WalletApi` send. */
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** `cursor` is the previous page's `next`; `limit` is 1..100 (the API's default is 50). */
export type FillsQuery = {
  venue?: PortfolioVenue;
  /** One market's fills (SEN-157). */
  symbol?: string;
  cursor?: string;
  limit?: number;
};

type Query = Record<string, string | number | undefined>;

export class TradeApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  constructor({ auth, baseUrl = API_URL, fetchImpl = unboundFetch }: TradeApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** `GET /trade/capabilities` — the one `/trade` route that answers with the flag off. */
  capabilities(): Promise<TradeCapabilities> {
    return this.request('GET', '/trade/capabilities');
  }

  /**
   * `POST /trade/prepare` — the steps the device key would sign. Sends nothing.
   * Verify every step's `payload` against `intent` before signing it.
   */
  prepare(intent: TradeIntent): Promise<PreparedTrade> {
    return this.request('POST', '/trade/prepare', { body: intent });
  }

  /**
   * `POST /trade/:tradeId/commit` — one base64 signature per step, by index.
   * Answers at once; poll `status` for the outcome. A second commit resends
   * nothing and returns the current view.
   */
  commit(tradeId: string, signatures: readonly string[]): Promise<TradeView> {
    return this.request('POST', `${tradePath(tradeId)}/commit`, { body: { signatures } });
  }

  /** `GET /trade/:tradeId` */
  status(tradeId: string): Promise<TradeView> {
    return this.request('GET', tradePath(tradeId));
  }

  /** `GET /trade?limit=` — newest first; the API accepts 1..100. In memory server-side. */
  list(limit?: number): Promise<TradeView[]> {
    return this.request('GET', '/trade', { query: { limit } });
  }

  /** `GET /trade/perpl/account`: the wallet's Perpl account and what onboarding still needs. */
  perplAccount(): Promise<PerplAccount> {
    return this.request('GET', '/trade/perpl/account');
  }

  /**
   * `POST /trade/perpl/enroll/prepare` — what the device key would sign to
   * enroll the phone's trade key (and the server's read key). Signs nothing.
   * Run `verifyEnrollmentPrepare` on the answer before signing any of it.
   */
  enrollPrepare(request: EnrollPrepareRequest): Promise<EnrollPrepareResult> {
    return this.request('POST', '/trade/perpl/enroll/prepare', { body: request });
  }

  /** `POST /trade/perpl/enroll/commit` — single use: a replay is 404 `enroll_prepare_not_found`. */
  enrollCommit(request: EnrollCommitRequest): Promise<EnrollCommitResult> {
    return this.request('POST', '/trade/perpl/enroll/commit', { body: request });
  }

  /** `GET /portfolio` (M-T19): wallet, Kuru account and Perpl account, read fresh. */
  portfolio(): Promise<Portfolio> {
    return this.request('GET', '/portfolio');
  }

  /** `GET /portfolio/fills?venue=&symbol=&cursor=&limit=` (M-T19): the user's own fills, newest first. */
  fills(query: FillsQuery = {}): Promise<PortfolioFills> {
    return this.request('GET', '/portfolio/fills', { query });
  }

  /** `GET /portfolio/history?range=` (SEN-152): the recorded ≈ $ total, oldest first. */
  valueHistory(range: HistoryRange): Promise<ValueHistory> {
    return this.request('GET', '/portfolio/history', { query: { range } });
  }

  /** One request, and at most one silent re-authentication — see `WalletApi`. */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    { body, query }: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${queryString(query)}`;
    const token = this.auth.token();
    // No token yet is the normal state right after sign-in; sending anyway
    // would spend a round trip on a guaranteed 401 (as `WalletApi` does).
    if (token === null) {
      return this.read<T>(await this.send(method, url, body, await this.auth.refresh()));
    }

    const first = await this.send(method, url, body, token);
    if (first.status !== 401) return this.read<T>(first);

    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read<T>(first);
    return this.read<T>(await this.send(method, url, body, refreshed));
  }

  private send(method: string, url: string, body: unknown, token: string | null) {
    return this.fetchImpl(url, {
      method,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      throw new TradeApiError(response.status, detail?.reason, message);
    }
    return parsed as T;
  }
}

/** The id ends up in a path segment; the server wants a UUID, but encode anyway. */
function tradePath(tradeId: string): string {
  return `/trade/${encodeURIComponent(tradeId)}`;
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
