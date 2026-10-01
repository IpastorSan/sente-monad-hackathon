import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { MarketsApi } from '../markets/api.ts';
import { WalletApi } from '../wallet/api.ts';
import { unboundFetch } from './fetch.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A fetch that behaves like a browser's: it refuses any receiver but the global
 * object (or none). Node's own fetch accepts any receiver, which is how the
 * browser-only failure stayed invisible to every other spec.
 */
function installBrowserLikeFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    calls.push(String(input));
    return Promise.resolve(new Response('{}', { status: 200 }));
  } as typeof fetch;
  return { calls };
}

const auth = { token: () => 'token', refresh: async () => 'token' };

test('unboundFetch reaches the global fetch with a legal receiver', async () => {
  const { calls } = installBrowserLikeFetch();
  const holder = { fetchImpl: unboundFetch };
  await holder.fetchImpl('https://api.example/health');
  assert.deepEqual(calls, ['https://api.example/health']);
});

test('a client built without fetchImpl survives a browser-like fetch', async () => {
  const { calls } = installBrowserLikeFetch();
  await new WalletApi({ auth, baseUrl: 'https://api.example' })
    .register('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE')
    .catch(() => undefined);
  await new MarketsApi({ auth, baseUrl: 'https://api.example' }).markets().catch(() => undefined);
  assert.equal(calls.length, 2);
});
