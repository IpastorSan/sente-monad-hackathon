/**
 * `WalletApi` request shapes and wire mapping, against a recording `fetch`.
 * Plain node, no API, no device.
 *
 * What these pin is the contract with `services/api/src/wallet` after SEN-40
 * moved the routes: `/wallet` is the user's PRIVY wallet and takes a device
 * public key, while the Kernel account lives under `/wallet/kernel`. Posting an
 * owner address to `/wallet/register` is a 400 on the live API and would look
 * to a user like "the app cannot find my wallet", so the paths and the body
 * keys are asserted rather than assumed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  balanceOf,
  toUserWallet,
  WalletApi,
  WalletApiError,
  type SessionAuth,
  type WireUserWallet,
} from './api.ts';

const BASE = 'http://api.test';
const TOKEN = 'v1.session-token';
const OWNER = '0x1111111111111111111111111111111111111111';
const DEVICE_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdA==';

const WIRE_WALLET: WireUserWallet = {
  userId: OWNER,
  walletId: 'wallet00000000000000test',
  address: '0x95206CCBE0735bf436b39226DCaA5DF536FA6d5e',
  ownerQuorumId: 'quorum00000000000000test',
  devicePublicKey: DEVICE_KEY,
  chainId: 10143,
  createdAt: '2026-09-18T11:55:17.869Z',
  balances: [
    {
      symbol: 'MON',
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      raw: '2500000000000000000',
      amount: '2.5',
    },
    {
      symbol: 'USDC',
      address: '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E',
      decimals: 6,
      raw: '0',
      amount: '0',
    },
    {
      symbol: 'AUSD',
      address: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
      decimals: 6,
      raw: '1204500000',
      amount: '1204.5',
    },
  ],
};

type Reply = { status: number; body?: unknown; text?: string };
type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A session that never expires, for the cases that are not about expiry. */
function fixedToken(token: string): SessionAuth {
  return { token: () => token, refresh: () => Promise.resolve(token) };
}

function recordingApi(...replies: Reply[]) {
  return recordingApiWith(fixedToken(TOKEN), ...replies);
}

function recordingApiWith(auth: SessionAuth, ...replies: Reply[]) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text === '' ? null : text, { status: reply.status });
  }) as typeof fetch;
  return { api: new WalletApi({ auth, baseUrl: `${BASE}/`, fetchImpl }), calls };
}

test('register posts the DEVICE KEY to /wallet/register, and nothing else', async () => {
  const { api, calls } = recordingApi({ status: 200, body: WIRE_WALLET });

  await api.register(DEVICE_KEY);

  assert.equal(calls[0]?.url, `${BASE}/wallet/register`);
  assert.equal(calls[0]?.method, 'POST');
  // No owner, no userId: identity is the bearer token's subject.
  assert.deepEqual(calls[0]?.body, { devicePublicKey: DEVICE_KEY });
  assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
});

test('account is GET /wallet and maps every balance to bigint atoms', async () => {
  const { api, calls } = recordingApi({ status: 200, body: WIRE_WALLET });

  const wallet = await api.account();

  assert.equal(calls[0]?.url, `${BASE}/wallet`);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(wallet.address, WIRE_WALLET.address);
  assert.equal(wallet.walletId, WIRE_WALLET.walletId);
  assert.equal(wallet.ownerQuorumId, WIRE_WALLET.ownerQuorumId);
  assert.deepEqual(
    wallet.balances.map((balance) => balance.raw),
    [2_500_000_000_000_000_000n, 0n, 1_204_500_000n],
  );
  // The server's decimal form is carried through untouched, not recomputed.
  assert.equal(wallet.balances[2]?.amount, '1204.5');
});

test('the Kernel account keeps its own routes under /wallet/kernel', async () => {
  const { api, calls } = recordingApi(
    { status: 200, body: { address: OWNER } },
    { status: 200, body: { address: OWNER } },
  );

  await api.registerKernel(OWNER);
  await api.kernelAccount();

  assert.equal(calls[0]?.url, `${BASE}/wallet/kernel/register`);
  assert.deepEqual(calls[0]?.body, { owner: OWNER });
  assert.equal(calls[1]?.url, `${BASE}/wallet/kernel`);
  assert.equal(calls[1]?.method, 'GET');
});

test('a 401 is retried once with a fresh token', async () => {
  let token = 'stale';
  const auth: SessionAuth = {
    token: () => token,
    refresh: async () => {
      token = TOKEN;
      return token;
    },
  };
  const { api, calls } = recordingApiWith(
    auth,
    { status: 401, body: { message: 'expired' } },
    { status: 200, body: WIRE_WALLET },
  );

  const wallet = await api.account();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers.authorization, 'Bearer stale');
  assert.equal(calls[1]?.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(wallet.address, WIRE_WALLET.address);
});

test('a client with no token yet signs in first, instead of spending a 401', async () => {
  let token: string | null = null;
  const auth: SessionAuth = {
    token: () => token,
    refresh: async () => {
      token = TOKEN;
      return token;
    },
  };
  const { api, calls } = recordingApiWith(auth, { status: 200, body: WIRE_WALLET });

  // The state at sign-in: the device key is ready before the challenge and
  // response have landed, and both wallet clients register at once.
  await api.register(DEVICE_KEY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
});

test('a refusal keeps the API reason, which is what the screen branches on', async () => {
  const { api } = recordingApi({
    status: 409,
    body: { reason: 'device_key_mismatch', message: 'another key owns this wallet' },
  });

  await assert.rejects(
    () => api.register(DEVICE_KEY),
    (error: unknown) => {
      assert.ok(error instanceof WalletApiError);
      assert.equal(error.status, 409);
      assert.equal(error.reason, 'device_key_mismatch');
      return true;
    },
  );
});

test('balanceOf finds a token by symbol and is null for one the API did not send', () => {
  const wallet = toUserWallet(WIRE_WALLET);

  assert.equal(balanceOf(wallet, 'AUSD')?.raw, 1_204_500_000n);
  assert.equal(balanceOf(wallet, 'AUSD')?.decimals, 6);
  // Not zero: a missing token means the token lists disagree, and rendering it
  // as 0.00 would be a confident lie about money.
  assert.equal(balanceOf(wallet, 'WETH'), null);
  assert.equal(balanceOf(null, 'AUSD'), null);
});
