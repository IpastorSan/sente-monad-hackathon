import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERPL_NETWORKS } from '@sente/venues/perpl';

import { PERPL_NETWORK } from './perplNetwork.ts';
import { perplProxyNetwork } from './perplProxy.ts';

test('production: REST and sockets under api.sente.lol/perpl, on testnet', () => {
  assert.deepEqual(perplProxyNetwork('https://api.sente.lol'), {
    restUrl: 'https://api.sente.lol/perpl/api',
    wsUrl: 'wss://api.sente.lol/perpl',
    chainId: 10143,
  });
});

test('the adapter’s own paths land on the Caddyfile’s two prefixes', () => {
  const { restUrl, wsUrl } = perplProxyNetwork('https://api.sente.lol');
  // rest.ts appends the target; trading.ts and ws.ts append /ws/v1/….
  assert.equal(`${restUrl}/v1/pub/context`, 'https://api.sente.lol/perpl/api/v1/pub/context');
  assert.equal(`${wsUrl}/ws/v1/trading`, 'wss://api.sente.lol/perpl/ws/v1/trading');
});

test('a trailing slash, a port and a path prefix are kept, the slash once', () => {
  assert.deepEqual(
    perplProxyNetwork('https://api.sente.lol/'),
    perplProxyNetwork('https://api.sente.lol'),
  );
  assert.equal(
    perplProxyNetwork('https://api.sente.lol:8475').wsUrl,
    'wss://api.sente.lol:8475/perpl',
  );
  assert.equal(
    perplProxyNetwork('https://x.test/sente/').restUrl,
    'https://x.test/sente/perpl/api',
  );
});

test('plain http (a local API) maps to ws, never wss', () => {
  assert.deepEqual(perplProxyNetwork('http://localhost:3000'), {
    restUrl: 'http://localhost:3000/perpl/api',
    wsUrl: 'ws://localhost:3000/perpl',
    chainId: 10143,
  });
});

test('refuses what is not a base URL', () => {
  assert.throws(() => perplProxyNetwork('not a url'));
  assert.throws(() => perplProxyNetwork('ftp://api.sente.lol'), /http\(s\)/);
  assert.throws(() => perplProxyNetwork('https://api.sente.lol/?x=1'), /query/);
});

test('native goes to Perpl directly, nothing of Sente in between', () => {
  assert.deepEqual(PERPL_NETWORK, PERPL_NETWORKS.testnet);
});
