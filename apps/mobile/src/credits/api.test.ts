/**
 * `CreditsApi` against a recording `fetch` (SEN-183): the routes, the bearer
 * token, one re-authentication on a 401, the error body, and parses that turn
 * a malformed answer into a safe default rather than a crash.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOSED_PLANS,
  CreditsApi,
  CreditsApiError,
  parseOverview,
  parsePlans,
  PURCHASES_CLOSED_NOTE,
} from './api.ts';

const BASE = 'http://api.test';

/** `GET /credits` as the API answers it. */
const OVERVIEW = {
  limitUsd: 10,
  remainingUsd: 8.75,
  usageMonthUsd: 1.25,
  resetsAt: '2026-11-01T00:00:00.000Z',
  tier: 'free',
  provisioned: true,
  mode: 'per-user',
  freeTierUsd: 10,
  usedUsd: 1.25,
  reset: {
    period: 'monthly',
    resetsAt: '2026-11-01T00:00:00.000Z',
    rollover: false,
    summary: 'Resets to the full limit at 00:00 UTC on the 1st of each month.',
  },
  usage: {
    estimated: true,
    windowStart: '2026-10-01T00:00:00.000Z',
    byAgent: [
      {
        agentId: 'a1',
        name: 'Night desk',
        runs: 2,
        costUsd: 0.3,
        inputTokens: 2000,
        outputTokens: 200,
        lastRunAt: 1_700_000_000_000,
      },
    ],
    attributedUsd: 0.3,
    unattributedUsd: 0.95,
    recentRuns: [
      {
        runId: 'run-1',
        agentId: 'a1',
        agentName: 'Night desk',
        trigger: 'schedule',
        model: 'moonshotai/kimi-k2.6',
        status: 'ended',
        stopReason: 'end_turn',
        startedAt: 1_700_000_000_000,
        costUsd: null,
        inputTokens: 1000,
        outputTokens: 100,
      },
    ],
    note: 'Estimated from the last 10 runs Sente keeps per agent.',
  },
};

function recorder(...answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  }) as typeof fetch;
  const api = new CreditsApi({
    auth: { token: () => 'old', refresh: () => Promise.resolve('new') },
    baseUrl: `${BASE}/`,
    fetchImpl,
  });
  return { api, calls };
}

test('GET /credits with the session token, parsed', async () => {
  const { api, calls } = recorder({ status: 200, body: OVERVIEW });
  const overview = await api.overview();
  assert.equal(calls[0]!.url, `${BASE}/credits`);
  assert.deepEqual(calls[0]!.init?.headers, { authorization: 'Bearer old' });
  assert.equal(overview.remainingUsd, 8.75);
  assert.equal(overview.usedUsd, 1.25);
  assert.equal(overview.reset.period, 'monthly');
  assert.deepEqual(overview.usage.byAgent[0], {
    agentId: 'a1',
    name: 'Night desk',
    runs: 2,
    costUsd: 0.3,
    lastRunAt: 1_700_000_000_000,
  });
  assert.equal(overview.usage.recentRuns[0]!.costUsd, null);
  assert.equal(overview.usage.unattributedUsd, 0.95);
});

test('a 401 signs in again once and retries', async () => {
  const { api, calls } = recorder(
    { status: 401, body: { statusCode: 401, reason: 'session_expired', message: 'expired' } },
    { status: 200, body: OVERVIEW },
  );
  await api.overview();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.init?.headers, { authorization: 'Bearer new' });
});

test('a refusal surfaces as CreditsApiError with its reason', async () => {
  const { api } = recorder({
    status: 503,
    body: { statusCode: 503, reason: 'credits_unconfigured', message: 'not configured' },
  });
  await assert.rejects(api.overview(), (error: unknown) => {
    assert.ok(error instanceof CreditsApiError);
    assert.equal(error.status, 503);
    assert.equal(error.reason, 'credits_unconfigured');
    return true;
  });
});

test('GET /credits/plans parsed; a server without the route reads as the closed shop', async () => {
  const plans = {
    purchasesEnabled: false,
    note: PURCHASES_CLOSED_NOTE,
    currency: 'USD',
    freeTier: { usd: 10, reset: 'monthly' },
    plans: [
      { id: 'pack_10', usd: 10 },
      { id: 'custom', usd: null },
    ],
    custom: { minUsd: 5, maxUsd: 500 },
    autoTopUp: { thresholdsUsd: [1, 2, 5], amountsUsd: [10, 20, 50] },
    paymentAssets: ['USDC', 'AUSD'],
  };
  const ok = recorder({ status: 200, body: plans });
  const parsed = await ok.api.plans();
  assert.equal(ok.calls[0]!.url, `${BASE}/credits/plans`);
  assert.deepEqual(parsed.plans, plans.plans);
  assert.equal(parsed.purchasesEnabled, false);

  const missing = recorder({ status: 404, body: { statusCode: 404, message: 'Cannot GET' } });
  assert.deepEqual(await missing.api.plans(), CLOSED_PLANS);
});

test('parseOverview: the old four-field answer still reads; garbage reads as null', () => {
  const old = parseOverview({
    limitUsd: 5,
    remainingUsd: 4,
    usageMonthUsd: 1,
    resetsAt: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(old?.usedUsd, 1);
  assert.equal(old?.freeTierUsd, 5);
  assert.equal(old?.reset.resetsAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(old?.usage.byAgent, []);
  assert.equal(parseOverview(null), null);
  assert.equal(parseOverview({ limitUsd: 'ten' }), null);
});

test('parseOverview drops malformed rows instead of failing', () => {
  const parsed = parseOverview({
    ...OVERVIEW,
    usage: {
      ...OVERVIEW.usage,
      byAgent: [{ name: 'no id' }, ...OVERVIEW.usage.byAgent],
      recentRuns: ['x', { runId: 'r', agentId: 'a', startedAt: 'yesterday' }],
    },
  });
  assert.equal(parsed?.usage.byAgent.length, 1);
  assert.deepEqual(parsed?.usage.recentRuns, []);
});

test('parsePlans never reads a malformed answer as open', () => {
  assert.deepEqual(parsePlans('nope'), CLOSED_PLANS);
  const odd = parsePlans({ purchasesEnabled: 'yes', plans: 'many' });
  assert.equal(odd.purchasesEnabled, false);
  assert.equal(odd.note, PURCHASES_CLOSED_NOTE);
  assert.deepEqual(odd.plans, CLOSED_PLANS.plans);
  assert.equal(parsePlans({ purchasesEnabled: true }).note, null);
});

test('the free tier is one-off by default: no reset unless the server says otherwise (SEN-183)', () => {
  assert.deepEqual(CLOSED_PLANS.freeTier, { usd: 10, reset: null });
  const parsed = parsePlans({ purchasesEnabled: false, freeTier: { usd: 10 } });
  assert.deepEqual(parsed.freeTier, { usd: 10, reset: null });
});
