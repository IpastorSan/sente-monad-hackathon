/**
 * `TradeApi` against a recording `fetch` (SEN-102, plan M-T20). Pins each
 * method's route, verb and body, the bearer token and its one retry, how every
 * `/trade` refusal surfaces, and the build/server/network gate.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPerpsEnabled, isTradingEnabled, isUnavailable, TradeApi, TradeApiError } from './api.ts';
import type { TradeCapabilities, TradeIntent, TradeRefusalReason } from './types.ts';

const BASE = 'http://api.test';
const TRADE_ID = '6f1c1c9e-6a3b-4b8e-9f00-3b7d2d5c1a10';

function recorder(responses: { status: number; body?: unknown }[] = [{ status: 200 }]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let refreshes = 0;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const next = responses[Math.min(calls.length, responses.length - 1)]!;
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(next.body ?? {}), { status: next.status }));
  }) as typeof fetch;
  const api = new TradeApi({
    auth: {
      token: () => 'tok',
      refresh: () => {
        refreshes += 1;
        return Promise.resolve('fresh');
      },
    },
    baseUrl: `${BASE}/`,
    fetchImpl,
  });
  return { api, calls, refreshes: () => refreshes };
}

const INTENT: TradeIntent = {
  kind: 'kuru.withdraw',
  clientTradeId: 'a0000000-0000-4000-8000-000000000001',
  token: '0x0000000000000000000000000000000000000000',
  amountAtoms: '1000',
};

test('each method hits its route with the session token', async () => {
  const { api, calls } = recorder();
  await api.capabilities();
  await api.prepare(INTENT);
  await api.commit(TRADE_ID, ['c2ln']);
  await api.status(TRADE_ID);
  await api.list();
  await api.list(20);
  await api.portfolio();
  await api.fills();
  await api.fills({ venue: 'perpl', cursor: '50', limit: 20 });

  assert.deepEqual(
    calls.map((c) => `${c.init?.method} ${c.url}`),
    [
      `GET ${BASE}/trade/capabilities`,
      `POST ${BASE}/trade/prepare`,
      `POST ${BASE}/trade/${TRADE_ID}/commit`,
      `GET ${BASE}/trade/${TRADE_ID}`,
      `GET ${BASE}/trade`,
      `GET ${BASE}/trade?limit=20`,
      `GET ${BASE}/portfolio`,
      `GET ${BASE}/portfolio/fills`,
      `GET ${BASE}/portfolio/fills?venue=perpl&cursor=50&limit=20`,
    ],
  );
  for (const { init } of calls) {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer tok');
  }
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), INTENT);
  assert.deepEqual(JSON.parse(calls[2]!.init!.body as string), { signatures: ['c2ln'] });
  assert.equal(
    (calls[1]!.init!.headers as Record<string, string>)['content-type'],
    'application/json',
  );
  assert.equal(calls[0]!.init!.body, undefined);
});

test('the Perpl routes: account, enroll prepare and commit, with their bodies', async () => {
  const { api, calls } = recorder();
  const prepare = { publicKeyHex: `0x${'ab'.repeat(32)}`, label: 'sente-app' } as const;
  const commit = {
    prepareId: TRADE_ID,
    signatures: ['c2ln', 'c2lo'],
    popSignature: `0x${'cd'.repeat(64)}`,
  } as const;
  await api.perplAccount();
  await api.enrollPrepare(prepare);
  await api.enrollCommit(commit);
  assert.deepEqual(
    calls.map((c) => `${c.init?.method} ${c.url}`),
    [
      `GET ${BASE}/trade/perpl/account`,
      `POST ${BASE}/trade/perpl/enroll/prepare`,
      `POST ${BASE}/trade/perpl/enroll/commit`,
    ],
  );
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), prepare);
  assert.deepEqual(JSON.parse(calls[2]!.init!.body as string), commit);
});

test('the answer is returned as sent', async () => {
  const capabilities: TradeCapabilities = {
    enabled: true,
    atomicBatch: false,
    chainId: 10143,
    venues: { kuru: true, perpl: false },
  };
  const { api } = recorder([{ status: 200, body: capabilities }]);
  assert.deepEqual(await api.capabilities(), capabilities);
});

test('a 401 re-authenticates once and retries with the fresh token', async () => {
  const { api, calls, refreshes } = recorder([{ status: 401 }, { status: 200, body: [] }]);
  assert.deepEqual(await api.list(), []);
  assert.equal(refreshes(), 1);
  assert.equal(calls.length, 2);
  assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization, 'Bearer fresh');
});

const REFUSALS: [TradeRefusalReason, number][] = [
  ['trading_disabled', 404],
  ['trade_not_found', 404],
  ['trade_id_conflict', 409],
  ['already_terminal', 409],
  ['trade_expired', 410],
  ['not_supported_yet', 400],
  ['signature_count_mismatch', 400],
  ['invalid_intent', 400],
  ['market_not_allowed', 400],
  ['below_min_notional', 422],
  ['reserve_balance', 422],
  ['deposit_cap_exceeded', 422],
  ['insufficient_balance', 422],
  ['below_min_account_open', 422],
  ['perpl_already_onboarded', 409],
];

for (const [reason, status] of REFUSALS) {
  test(`${status} ${reason} is a TradeApiError with its reason, never "unavailable"`, async () => {
    const { api } = recorder([{ status, body: { statusCode: status, reason, message: 'no' } }]);
    const error = await api.commit(TRADE_ID, ['c2ln']).catch((e: unknown) => e);
    assert.ok(error instanceof TradeApiError);
    assert.equal(error.status, status);
    assert.equal(error.reason, reason);
    assert.equal(error.message, 'no');
    assert.equal(isUnavailable(error), false);
  });
}

test('a reasonless 404 is an API without the route: unavailable', async () => {
  const { api } = recorder([
    { status: 404, body: { statusCode: 404, message: 'Cannot GET /portfolio' } },
  ]);
  const error = await api.portfolio().catch((e: unknown) => e);
  assert.ok(error instanceof TradeApiError);
  assert.equal(isUnavailable(error), true);
  assert.equal(error.message, 'Cannot GET /portfolio');
});

test('a validation 400 joins its messages', async () => {
  const { api } = recorder([
    { status: 400, body: { statusCode: 400, message: ['kind must be one of', 'bad uuid'] } },
  ]);
  const error = (await api.prepare(INTENT).catch((e: unknown) => e)) as TradeApiError;
  assert.equal(error.reason, undefined);
  assert.equal(error.message, 'kind must be one of; bad uuid');
});

test('trading is on only with the build flag, the server flag and testnet', () => {
  const on: TradeCapabilities = {
    enabled: true,
    atomicBatch: true,
    chainId: 10143,
    venues: { kuru: true, perpl: true },
  };
  const ok = { buildFlag: '1', capabilities: on, network: 'testnet' } as const;
  assert.equal(isTradingEnabled(ok), true);
  assert.equal(isTradingEnabled({ ...ok, buildFlag: undefined }), false);
  assert.equal(isTradingEnabled({ ...ok, buildFlag: 'true' }), false);
  assert.equal(isTradingEnabled({ ...ok, capabilities: null }), false);
  assert.equal(isTradingEnabled({ ...ok, capabilities: { ...on, enabled: false } }), false);
  assert.equal(isTradingEnabled({ ...ok, network: 'mainnet' }), false);
});

test('perps are on only with trading on and the Perpl venue on', () => {
  const on: TradeCapabilities = {
    enabled: true,
    atomicBatch: false,
    chainId: 10143,
    venues: { kuru: true, perpl: true },
  };
  const ok = { buildFlag: '1', capabilities: on, network: 'testnet' } as const;
  assert.equal(isPerpsEnabled(ok), true);
  assert.equal(
    isPerpsEnabled({ ...ok, capabilities: { ...on, venues: { kuru: true, perpl: false } } }),
    false,
  );
  assert.equal(isPerpsEnabled({ ...ok, capabilities: { ...on, enabled: false } }), false);
  assert.equal(isPerpsEnabled({ ...ok, buildFlag: undefined }), false);
  assert.equal(isPerpsEnabled({ ...ok, network: 'mainnet' }), false);
});

test('Kuru trading is on only when the API’s Sente fee is the one this build pins (SEN-184)', () => {
  const pin = { address: '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8', feePps: 10_000 } as const;
  const on: TradeCapabilities = {
    enabled: true,
    atomicBatch: false,
    chainId: 10143,
    venues: { kuru: true, perpl: true },
    kuruBuilder: pin,
  };
  const ok = { buildFlag: '1', capabilities: on, network: 'testnet', builderPin: pin } as const;
  assert.equal(isTradingEnabled(ok), true);
  // The server charges a fee this build would refuse at the signature: off.
  assert.equal(isTradingEnabled({ ...ok, builderPin: null }), false);
  assert.equal(isTradingEnabled({ ...ok, builderPin: { ...pin, feePps: 5_000 } }), false);
  // The server charges nothing while the build expects a fee: off too, so a
  // deploy and an app release out of step read as such.
  assert.equal(isTradingEnabled({ ...ok, capabilities: { ...on, kuruBuilder: null } }), false);
  // An API older than SEN-184 against a build without a pin: on.
  const older: TradeCapabilities = { ...on };
  delete (older as { kuruBuilder?: unknown }).kuruBuilder;
  assert.equal(isTradingEnabled({ ...ok, capabilities: older, builderPin: null }), true);
  // Perpl carries no Sente fee, so a Kuru mismatch leaves perps alone.
  assert.equal(isPerpsEnabled({ ...ok, builderPin: null }), true);
});
