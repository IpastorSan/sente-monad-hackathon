/**
 * `AgentsApi` request shapes, against a recording `fetch`. Plain node, no API.
 *
 * What these pin is the contract with `services/api/src/agents` (SEN-5): the
 * route and method, the placeholder identity header and nothing else that
 * names a user, and every atom amount crossing the wire as a decimal string
 * (never a JS number, which `parseMandate` refuses).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentsApi,
  AgentsApiError,
  describeAgentsError,
  forkName,
  fromWireMandate,
  toWireMandate,
  type WireAgent,
  type WireMandate,
} from './api.ts';

const BASE = 'http://api.test';
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AGENT_ID = '5b0f8a62-3c1e-4d7a-9f0e-2a6b7c8d9e01';

const MON_USDC = '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61';
const USDC = '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E';
const MON = '0x0000000000000000000000000000000000000000';

const WIRE_MANDATE: WireMandate = {
  version: 1,
  chainId: 10143,
  expiresAt: 2_000_000_000,
  venues: ['kuru', 'perpl'],
  kuru: {
    markets: [MON_USDC],
    maxDepositAtoms: { [USDC]: '1000000000', [MON]: '5000000000000000000' },
  },
  perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: ['BTC-PERP'] },
  maxOrderNotional: '250.5',
};

const WIRE_AGENT: WireAgent = {
  id: AGENT_ID,
  name: 'Night desk',
  systemPrompt: 'Trade calmly.',
  strategy: 'Mean reversion on MON-USDC.',
  model: 'anthropic/claude-sonnet-5',
  mandate: WIRE_MANDATE,
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  walletId: 'wallet-1',
  policyId: 'policy-1',
  status: 'active',
  public: false,
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
};

type Reply = { status: number; body?: unknown; text?: string };
type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function recordingApi(...replies: Reply[]) {
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
  return { api: new AgentsApi({ userId: OWNER, baseUrl: `${BASE}/`, fetchImpl }), calls };
}

test('list is GET /agents with only the identity header, and returns bigint atoms', async () => {
  const { api, calls } = recordingApi({ status: 200, body: { agents: [WIRE_AGENT] } });
  const agents = await api.list();

  assert.deepEqual(calls, [
    { url: `${BASE}/agents`, method: 'GET', headers: { 'x-sente-user-id': OWNER } },
  ]);
  const mandate = agents[0]?.mandate;
  assert.equal(mandate?.kuru.maxDepositAtoms[USDC], 1_000_000_000n);
  assert.equal(mandate?.kuru.maxDepositAtoms[MON], 5_000_000_000_000_000_000n);
  assert.equal(mandate?.perpl.maxCollateralAtoms, 500_000_000n);
});

test('hire posts exactly the CreateAgentDto fields, atoms as decimal strings, no userId', async () => {
  const { api, calls } = recordingApi({
    status: 201,
    body: { agent: WIRE_AGENT, mcpToken: 'sente_mcp_secret' },
  });
  const result = await api.hire({
    name: 'Night desk',
    systemPrompt: 'Trade calmly.',
    strategy: 'Mean reversion on MON-USDC.',
    model: 'anthropic/claude-sonnet-5',
    mandate: fromWireMandate(WIRE_MANDATE),
  });

  const call = calls[0];
  assert.equal(call?.url, `${BASE}/agents`);
  assert.equal(call?.method, 'POST');
  assert.deepEqual(call?.headers, {
    'x-sente-user-id': OWNER,
    'content-type': 'application/json',
  });
  assert.deepEqual(Object.keys(call?.body as object).sort(), [
    'mandate',
    'model',
    'name',
    'strategy',
    'systemPrompt',
  ]);
  assert.deepEqual((call?.body as { mandate: unknown }).mandate, WIRE_MANDATE);

  assert.equal(result.mcpToken, 'sente_mcp_secret');
  assert.equal(result.agent.mandate.perpl.maxCollateralAtoms, 500_000_000n);
});

test('fork posts only the mandate (and the name) to /agents/:id/fork (SEN-28)', async () => {
  const forked: WireAgent = {
    ...WIRE_AGENT,
    id: '99999999-9999-4999-8999-999999999999',
    name: 'Night desk (fork)',
    forkedFrom: AGENT_ID,
  };
  const { api, calls } = recordingApi({
    status: 201,
    body: { agent: forked, mcpToken: 'sente_mcp_fork' },
  });

  const result = await api.fork(AGENT_ID, {
    mandate: fromWireMandate(WIRE_MANDATE),
    name: 'Night desk (fork)',
  });

  const call = calls[0];
  assert.equal(call?.url, `${BASE}/agents/${AGENT_ID}/fork`);
  assert.equal(call?.method, 'POST');
  assert.deepEqual(call?.headers, {
    'x-sente-user-id': OWNER,
    'content-type': 'application/json',
  });
  // The strategy and the prompt come from the source agent: a fork body that
  // carried them would be a different agent wearing its name.
  assert.deepEqual(Object.keys(call?.body as object).sort(), ['mandate', 'name']);
  assert.deepEqual((call?.body as { mandate: unknown }).mandate, WIRE_MANDATE);

  assert.equal(result.mcpToken, 'sente_mcp_fork');
  assert.equal(result.agent.forkedFrom, AGENT_ID);
  assert.equal(result.agent.mandate.perpl.maxCollateralAtoms, 500_000_000n);
});

test('an unnamed fork omits the name rather than sending a guess', async () => {
  const { api, calls } = recordingApi({
    status: 201,
    body: { agent: WIRE_AGENT, mcpToken: 'sente_mcp_fork' },
  });
  await api.fork(AGENT_ID, { mandate: fromWireMandate(WIRE_MANDATE) });

  assert.deepEqual(Object.keys(calls[0]?.body as object), ['mandate']);
});

test('forkName mirrors the API’s default, inside the name limit', () => {
  assert.equal(forkName('Night desk'), 'Night desk (fork)');
  assert.equal(forkName('  Night desk  '), 'Night desk (fork)');
  assert.equal(forkName('x'.repeat(64)), `${'x'.repeat(57)} (fork)`);
  assert.equal(forkName('x'.repeat(64)).length, 64);
});

test('hire carries the sharing flag only when it is set', async () => {
  const { api, calls } = recordingApi(
    { status: 201, body: { agent: WIRE_AGENT, mcpToken: 'a' } },
    { status: 201, body: { agent: WIRE_AGENT, mcpToken: 'b' } },
  );
  const drafted = {
    name: 'Night desk',
    systemPrompt: 'Trade calmly.',
    strategy: 'Mean reversion on MON-USDC.',
    model: 'anthropic/claude-sonnet-5',
    mandate: fromWireMandate(WIRE_MANDATE),
  };

  await api.hire(drafted);
  await api.hire({ ...drafted, public: true });

  assert.equal((calls[0]?.body as { public?: boolean }).public, undefined);
  assert.equal((calls[1]?.body as { public?: boolean }).public, true);
});

test('atoms beyond Number.MAX_SAFE_INTEGER survive the wire exactly', () => {
  const huge = 123_456_789_012_345_678_901_234n;
  const mandate = fromWireMandate(WIRE_MANDATE);
  mandate.kuru.maxDepositAtoms[MON] = huge;

  const wire = JSON.parse(JSON.stringify(toWireMandate(mandate))) as WireMandate;
  assert.equal(wire.kuru.maxDepositAtoms[MON], '123456789012345678901234');
  assert.equal(fromWireMandate(wire).kuru.maxDepositAtoms[MON], huge);
});

test('a rolling cap round-trips with its atoms as a string', () => {
  const withCap: WireMandate = {
    ...WIRE_MANDATE,
    rollingCap: { windowSeconds: 86_400, capAtoms: '2000000000', token: USDC },
  };
  assert.deepEqual(toWireMandate(fromWireMandate(withCap)), withCap);
  assert.equal(fromWireMandate(withCap).rollingCap?.capAtoms, 2_000_000_000n);
});

test('get, amendMandate and revoke hit their routes; ids are URL-encoded', async () => {
  const { api, calls } = recordingApi(
    { status: 200, body: WIRE_AGENT },
    { status: 200, body: WIRE_AGENT },
    { status: 200, body: { ...WIRE_AGENT, status: 'revoked', policyCleared: true } },
  );
  await api.get('a/b');
  await api.amendMandate(AGENT_ID, fromWireMandate(WIRE_MANDATE));
  const revoked = await api.revoke(AGENT_ID);

  assert.equal(calls[0]?.url, `${BASE}/agents/a%2Fb`);
  assert.equal(calls[0]?.method, 'GET');

  assert.equal(calls[1]?.url, `${BASE}/agents/${AGENT_ID}/mandate`);
  assert.equal(calls[1]?.method, 'PATCH');
  assert.deepEqual(calls[1]?.body, { mandate: WIRE_MANDATE });

  assert.equal(calls[2]?.url, `${BASE}/agents/${AGENT_ID}/revoke`);
  assert.equal(calls[2]?.method, 'POST');
  assert.equal(calls[2]?.body, undefined, 'revoke sends no body');
  assert.deepEqual(calls[2]?.headers, { 'x-sente-user-id': OWNER });
  assert.equal(revoked.status, 'revoked');
});

test('run posts the instruction when there is one, and nothing when there is not', async () => {
  const result = { runId: 'run-1', stopReason: 'end_turn', iterations: 3 };
  const { api, calls } = recordingApi({ status: 200, body: result }, { status: 200, body: result });
  assert.deepEqual(await api.run(AGENT_ID, 'check MON'), { kind: 'completed', result });
  await api.run(AGENT_ID);

  assert.equal(calls[0]?.url, `${BASE}/agents/${AGENT_ID}/run`);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { instruction: 'check MON' });
  assert.equal(calls[1]?.body, undefined);
});

test('run reports a missing route (Nest 404, no reason) as unavailable', async () => {
  const { api } = recordingApi({
    status: 404,
    body: { statusCode: 404, message: `Cannot POST /agents/${AGENT_ID}/run`, error: 'Not Found' },
  });
  assert.deepEqual(await api.run(AGENT_ID), { kind: 'unavailable' });
});

test('run still throws a 404 that is about the agent', async () => {
  const { api } = recordingApi({
    status: 404,
    body: { statusCode: 404, reason: 'agent_not_found', message: 'no such agent' },
  });
  await assert.rejects(api.run(AGENT_ID), (error: unknown) => {
    assert.ok(error instanceof AgentsApiError);
    assert.equal(error.reason, 'agent_not_found');
    return true;
  });
});

test('refusals carry status, stable reason and a joined message', async () => {
  const { api } = recordingApi(
    {
      status: 400,
      body: { statusCode: 400, reason: 'mandate_invalid', message: ['a is bad', 'b is bad'] },
    },
    { status: 502, text: 'Bad Gateway' },
  );
  await assert.rejects(api.list(), (error: unknown) => {
    assert.ok(error instanceof AgentsApiError);
    assert.equal(error.status, 400);
    assert.equal(error.reason, 'mandate_invalid');
    assert.equal(error.message, 'a is bad; b is bad');
    return true;
  });
  await assert.rejects(api.list(), (error: unknown) => {
    assert.ok(error instanceof AgentsApiError);
    assert.equal(error.status, 502);
    assert.equal(error.reason, undefined);
    assert.equal(error.message, 'Bad Gateway');
    return true;
  });
});

test('describeAgentsError speaks to the reason, and to an unreachable API', () => {
  assert.equal(
    describeAgentsError(new AgentsApiError(409, 'agent_revoked', 'x')).title,
    'This agent is revoked',
  );
  assert.equal(
    describeAgentsError(new AgentsApiError(503, 'agent_wallets_unconfigured', 'x')).title,
    'Agent wallets aren’t configured on this API',
  );
  assert.equal(
    describeAgentsError(new TypeError('Network request failed')).title,
    'Couldn’t reach the API',
  );
});

test('leaderboard is GET /leaderboard, and keeps n beside the rate it belongs to', async () => {
  const { api, calls } = recordingApi({
    status: 200,
    body: {
      ranked: [
        {
          rank: 1,
          agentId: AGENT_ID,
          name: 'Night desk',
          model: 'anthropic/claude-sonnet-5',
          mandate: 'Kuru MON-USDC · max 250.5 per order',
          address: '0x1111111111111111111111111111111111111111',
          venues: ['kuru'],
          indexed: true,
          n: 8,
          wins: 5,
          losses: 3,
          fills: 26,
          winRate: 0.625,
          realisedPnlUsd: '25',
          capitalDeployedUsd: '100',
          roi: 0.25,
          theses: { settled: 3, held: 2, open: 1 },
        },
      ],
      tooFewTrades: [],
      formula:
        'n = settled trades (wins + losses) · win rate = wins ÷ n · ROI = realised PnL ÷ capital deployed',
      notes: ['n counts settled trades'],
      minTrades: 3,
      source: { kind: 'ok' },
      generatedAt: '2026-09-17T10:00:00.000Z',
    },
  });

  const board = await api.leaderboard();

  assert.deepEqual(calls, [
    { url: `${BASE}/leaderboard`, method: 'GET', headers: { 'x-sente-user-id': OWNER } },
  ]);
  const row = board.ranked[0];
  // The denominator travels with the rate: no row can render one without it.
  assert.equal(row?.n, 8);
  assert.equal(row?.winRate, 0.625);
  assert.equal(row?.roi, 0.25);
  assert.equal(row?.capitalDeployedUsd, '100');
  assert.deepEqual(row?.theses, { settled: 3, held: 2, open: 1 });
  assert.match(board.formula, /win rate = wins ÷ n/);
  assert.deepEqual(board.source, { kind: 'ok' });
});

test('leaderboard answers an empty board rather than undefined lists', async () => {
  const { api } = recordingApi({ status: 200, text: '{}' });

  const board = await api.leaderboard();

  assert.deepEqual(board.ranked, []);
  assert.deepEqual(board.tooFewTrades, []);
  assert.equal(board.minTrades, 3);
  assert.deepEqual(board.source, { kind: 'ok' });
});

test('an unconfigured board says so, and carries no rows to misread', async () => {
  const { api } = recordingApi({
    status: 200,
    body: {
      ranked: [],
      tooFewTrades: [],
      formula:
        'n = settled trades (wins + losses) · win rate = wins ÷ n · ROI = realised PnL ÷ capital deployed',
      notes: ['…', 'No indexer is configured (ENVIO_GRAPHQL_URL is unset)'],
      minTrades: 3,
      source: { kind: 'unconfigured', message: 'No indexer is configured' },
      generatedAt: '2026-09-17T10:00:00.000Z',
    },
  });

  const board = await api.leaderboard();

  assert.equal(board.source.kind, 'unconfigured');
  assert.equal(board.ranked.length, 0);
});
