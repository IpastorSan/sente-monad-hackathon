/**
 * `MarketsApi` against a recording `fetch` (SEN-110). Pins the B-T6 routes and
 * query strings, the bearer session token, and which 404 means "this API has
 * no such route" versus "no such market".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUnavailable, MarketsApi, MarketsApiError } from './api.ts';

const BASE = 'http://api.test';

function recorder(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  const api = new MarketsApi({
    auth: { token: () => 'tok', refresh: () => Promise.resolve('tok') },
    baseUrl: `${BASE}/`,
    fetchImpl,
  });
  return { api, calls };
}

test('each method hits its B-T6 route with the session token', async () => {
  const { api, calls } = recorder();
  await api.markets();
  await api.tickers();
  await api.tickers('perpl');
  await api.ticker('kuru', 'MON-USDC');
  await api.depth('kuru', 'MON-USDC', 10);
  await api.klines('perpl', 'ETH-PERP', { interval: '1h', limit: 200 });
  await api.quote('kuru', 'MON-USDC', { side: 'buy', size: '1.5', maxSlippage: '0.005' });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      `${BASE}/markets`,
      `${BASE}/markets/tickers`,
      `${BASE}/markets/tickers?venue=perpl`,
      `${BASE}/markets/kuru/MON-USDC/ticker`,
      `${BASE}/markets/kuru/MON-USDC/depth?limit=10`,
      `${BASE}/markets/perpl/ETH-PERP/klines?interval=1h&limit=200`,
      `${BASE}/markets/kuru/MON-USDC/quote?side=buy&size=1.5&maxSlippage=0.005`,
    ],
  );
  for (const { init } of calls) {
    assert.equal(init?.method, 'GET');
    assert.deepEqual(init?.headers, { authorization: 'Bearer tok' });
  }
});

test('a reasonless 404 is an API without the route: unavailable', async () => {
  const { api } = recorder(404, { statusCode: 404, message: 'Cannot GET /markets' });
  const error = await api.markets().catch((e: unknown) => e);
  assert.ok(error instanceof MarketsApiError);
  assert.equal(isUnavailable(error), true);
});

test('market_not_found is a real answer, and 503 carries retryAfterMs', async () => {
  const missing = recorder(404, {
    statusCode: 404,
    reason: 'market_not_found',
    message: 'No such market',
  });
  const notFound = await missing.api.ticker('kuru', 'NOPE').catch((e: unknown) => e);
  assert.equal(isUnavailable(notFound), false);
  assert.equal((notFound as MarketsApiError).reason, 'market_not_found');

  const down = recorder(503, {
    statusCode: 503,
    reason: 'venue_unavailable',
    message: 'Kuru is down',
    retryAfterMs: 5000,
  });
  const error = (await down.api.tickers().catch((e: unknown) => e)) as MarketsApiError;
  assert.equal(error.status, 503);
  assert.equal(error.retryAfterMs, 5000);
  assert.equal(error.message, 'Kuru is down');
});
