/**
 * `PresetsApi` against a recording `fetch` (SEN-114). Pins the B-T16b routes,
 * the bearer token, and that every 404 — route missing or preset unknown —
 * reads as "unavailable".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUnavailable, PresetsApi, PresetsApiError } from './api.ts';

const BASE = 'http://api.test';

function recorder(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  const api = new PresetsApi({
    auth: { token: () => 'tok', refresh: () => Promise.resolve('tok') },
    baseUrl: `${BASE}/`,
    fetchImpl,
  });
  return { api, calls };
}

test('list and stats hit their B-T16b routes with the session token', async () => {
  const { api, calls } = recorder();
  await api.list();
  await api.stats('range-trader');
  assert.deepEqual(
    calls.map((c) => c.url),
    [`${BASE}/presets`, `${BASE}/presets/range-trader/stats`],
  );
  for (const { init } of calls) {
    assert.equal(init?.method, 'GET');
    assert.deepEqual(init?.headers, { authorization: 'Bearer tok' });
  }
});

test('a missing route and an unknown preset are both unavailable', async () => {
  const route = recorder(404, { statusCode: 404, message: 'Cannot GET /presets' });
  const missing = await route.api.list().catch((e: unknown) => e);
  assert.ok(missing instanceof PresetsApiError);
  assert.equal(isUnavailable(missing), true);

  const preset = recorder(404, {
    statusCode: 404,
    reason: 'preset_not_found',
    message: 'No such preset',
  });
  const unknown = await preset.api.stats('nope').catch((e: unknown) => e);
  assert.equal(isUnavailable(unknown), true);
  assert.equal((unknown as PresetsApiError).reason, 'preset_not_found');
});

test('other failures are not "unavailable"', async () => {
  const { api } = recorder(500, { statusCode: 500, message: 'boom' });
  const error = await api.list().catch((e: unknown) => e);
  assert.equal(isUnavailable(error), false);
  assert.equal((error as PresetsApiError).message, 'boom');
});

test('a 401 re-authenticates once and retries with the new token', async () => {
  const seen: (string | undefined)[] = [];
  let first = true;
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>).authorization);
    const status = first ? 401 : 200;
    first = false;
    return Promise.resolve(new Response(JSON.stringify({ presets: [] }), { status }));
  }) as typeof fetch;
  const api = new PresetsApi({
    auth: { token: () => 'old', refresh: () => Promise.resolve('new') },
    baseUrl: BASE,
    fetchImpl,
  });
  assert.deepEqual(await api.list(), { presets: [] });
  assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
});
