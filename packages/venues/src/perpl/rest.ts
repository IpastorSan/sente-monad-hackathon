/**
 * Perpl REST: public reads plus API-key-signed requests.
 *
 * Perpl's REST surface is thin — context, candles, funding, and paginated
 * history. There is no order-book endpoint and no "current positions"
 * endpoint; live state comes from the trading WebSocket (`trading.ts`).
 */
import { ServerClock, newNonce, signRequest, type PerplCredentials } from './signing.ts';
import type { PerplCandleSeries, PerplContext } from './wire.ts';

export class PerplHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, request: string) {
    super(`Perpl ${request} -> ${status} ${body.slice(0, 200)}`);
    this.name = 'PerplHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface PerplRestOptions {
  /** e.g. `https://testnet.perpl.xyz/api`. */
  readonly restUrl: string;
  readonly chainId: number;
  /** Required only for `signed()` and the history reads. */
  readonly credentials?: PerplCredentials;
  readonly clock?: ServerClock;
  readonly fetchImpl?: typeof fetch;
}

export type HistoryKind = 'account-history' | 'fills' | 'order-history' | 'position-history';

export interface HistoryPage<T> {
  d: T[];
  /** Cursor for the next page; empty when there is none. */
  np: string;
}

export class PerplRest {
  readonly clock: ServerClock;
  private readonly restUrl: string;
  private readonly chainId: number;
  private readonly credentials: PerplCredentials | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PerplRestOptions) {
    this.restUrl = options.restUrl.replace(/\/+$/, '');
    this.chainId = options.chainId;
    this.credentials = options.credentials;
    this.clock = options.clock ?? new ServerClock();
    // Wrapped, not stored bare: a detached `fetch` throws "Illegal invocation"
    // in browsers when called as a method of another object.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  context(): Promise<PerplContext> {
    return this.get('/v1/pub/context');
  }

  /** Up to 1024 candles, oldest first. `resolution` in seconds. */
  candles(
    marketId: number,
    resolution: number,
    fromMs: number,
    toMs: number,
  ): Promise<PerplCandleSeries> {
    return this.get(`/v1/market-data/${marketId}/candles/${resolution}/${fromMs}-${toMs}`);
  }

  history<T>(kind: HistoryKind, count = 50, page?: string): Promise<HistoryPage<T>> {
    const query = `count=${count}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    return this.signed('GET', `/v1/trading/${kind}?${query}`);
  }

  /** Samples server time from a small unauthenticated response's `Date` header. */
  async syncClock(): Promise<void> {
    await this.send('GET', '/v1/profile/announcements', {});
  }

  async get<T>(target: string): Promise<T> {
    return this.parse<T>(await this.send('GET', target, {}), 'GET', target);
  }

  /**
   * An API-key-signed request. `target` is exactly what gets signed AND
   * fetched, so the two cannot drift apart byte-wise.
   *
   * A 401 is retried once after re-sampling the clock: a stale timestamp is
   * the one 401 cause a retry can fix, and a rejected request had no effect.
   */
  async signed<T>(method: 'GET' | 'POST', target: string, body?: string): Promise<T> {
    const credentials = this.credentials;
    if (!credentials) throw new Error('PerplRest has no API key credentials');
    if (!this.clock.isSynced) await this.syncClock();

    for (let attempt = 0; ; attempt++) {
      const headers = signRequest(credentials, {
        chainId: this.chainId,
        method,
        target,
        timestampMs: this.clock.now(),
        nonce: newNonce(),
        ...(body !== undefined ? { body } : {}),
      });
      const response = await this.send(method, target, headers, body);
      if (response.status === 401 && attempt === 0) {
        await this.syncClock();
        continue;
      }
      return this.parse<T>(response, method, target);
    }
  }

  private async send(
    method: string,
    target: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    const sentAt = this.clock.local();
    const response = await this.fetchImpl(`${this.restUrl}${target}`, {
      method,
      headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(body !== undefined ? { body } : {}),
    });
    this.clock.observe(response.headers.get('date'), sentAt, this.clock.local());
    return response;
  }

  private async parse<T>(response: Response, method: string, target: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) throw new PerplHttpError(response.status, text, `${method} ${target}`);
    return JSON.parse(text) as T;
  }
}
