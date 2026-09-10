/**
 * Perpl REST: public reads plus API-key-signed requests.
 *
 * Perpl's REST surface is thin — context, candles, funding, and paginated
 * history. There is no order-book endpoint and no "current positions"
 * endpoint; live state comes from the trading WebSocket (`trading.ts`).
 */
import { ServerClock, newNonce, signRequest } from './signing.ts';
export class PerplHttpError extends Error {
  status;
  body;
  constructor(status, body, request) {
    super(`Perpl ${request} -> ${status} ${body.slice(0, 200)}`);
    this.name = 'PerplHttpError';
    this.status = status;
    this.body = body;
  }
}
export class PerplRest {
  clock;
  restUrl;
  chainId;
  credentials;
  fetchImpl;
  constructor(options) {
    this.restUrl = options.restUrl.replace(/\/+$/, '');
    this.chainId = options.chainId;
    this.credentials = options.credentials;
    this.clock = options.clock ?? new ServerClock();
    // Wrapped, not stored bare: a detached `fetch` throws "Illegal invocation"
    // in browsers when called as a method of another object.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }
  context() {
    return this.get('/v1/pub/context');
  }
  /** Up to 1024 candles, oldest first. `resolution` in seconds. */
  candles(marketId, resolution, fromMs, toMs) {
    return this.get(`/v1/market-data/${marketId}/candles/${resolution}/${fromMs}-${toMs}`);
  }
  history(kind, count = 50, page) {
    const query = `count=${count}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    return this.signed('GET', `/v1/trading/${kind}?${query}`);
  }
  /** Samples server time from a small unauthenticated response's `Date` header. */
  async syncClock() {
    await this.send('GET', '/v1/profile/announcements', {});
  }
  async get(target) {
    return this.parse(await this.send('GET', target, {}), 'GET', target);
  }
  /**
   * An API-key-signed request. `target` is exactly what gets signed AND
   * fetched, so the two cannot drift apart byte-wise.
   *
   * A 401 is retried once after re-sampling the clock: a stale timestamp is
   * the one 401 cause a retry can fix, and a rejected request had no effect.
   */
  async signed(method, target, body) {
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
      return this.parse(response, method, target);
    }
  }
  async send(method, target, headers, body) {
    const sentAt = this.clock.local();
    const response = await this.fetchImpl(`${this.restUrl}${target}`, {
      method,
      headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(body !== undefined ? { body } : {}),
    });
    this.clock.observe(response.headers.get('date'), sentAt, this.clock.local());
    return response;
  }
  async parse(response, method, target) {
    const text = await response.text();
    if (!response.ok) throw new PerplHttpError(response.status, text, `${method} ${target}`);
    return JSON.parse(text);
  }
}
