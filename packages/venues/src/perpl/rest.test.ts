import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hexToBytes } from '@noble/hashes/utils.js';

import { PerplRest } from './rest.ts';
import { ServerClock } from './signing.ts';

const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');

test('signed request: syncs the clock first, signs the target it fetches, retries a 401 once', async () => {
  const serverNow = 1_789_065_422_000;
  const localNow = serverNow - 60_000; // a phone a minute slow would fail every request
  const requests: { url: string; headers: Headers }[] = [];
  let failNext = true;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });
    const date = new Date(serverNow).toUTCString();
    if (url.endsWith('/announcements')) return new Response('{}', { headers: { date } });
    if (failNext) {
      failNext = false;
      return new Response('Unauthorized', { status: 401, headers: { date } });
    }
    return new Response('{"d":[],"np":""}', { headers: { date } });
  }) as typeof fetch;

  const rest = new PerplRest({
    restUrl: 'https://testnet.perpl.xyz/api',
    chainId: 10143,
    credentials: { apiKey: 'token', secretKey: SECRET },
    clock: new ServerClock(() => localNow),
    fetchImpl,
  });
  const page = await rest.history('fills', 5);
  assert.deepEqual(page, { d: [], np: '' });

  const signed = requests.filter((r) => r.headers.has('x-api-signature'));
  assert.equal(signed.length, 2, 'one 401, one retry');
  for (const r of signed) {
    assert.equal(r.url, 'https://testnet.perpl.xyz/api/v1/trading/fills?count=5');
    const skew = Number(r.headers.get('x-api-timestamp')) - serverNow;
    assert.ok(Math.abs(skew) <= 1_000, `timestamp must be server time, was off by ${skew}ms`);
  }
  assert.notEqual(signed[0]!.headers.get('x-api-nonce'), signed[1]!.headers.get('x-api-nonce'));
  assert.ok(requests[0]!.url.endsWith('/v1/profile/announcements'), 'clock synced before signing');
});

test('a persistent 401 surfaces instead of looping', async () => {
  const fetchImpl = (async () =>
    new Response('Unauthorized', {
      status: 401,
      headers: { date: new Date().toUTCString() },
    })) as typeof fetch;
  const rest = new PerplRest({
    restUrl: 'https://x/api',
    chainId: 10143,
    credentials: { apiKey: 'token', secretKey: SECRET },
    fetchImpl,
  });
  await assert.rejects(rest.history('fills'), /401/);
});
