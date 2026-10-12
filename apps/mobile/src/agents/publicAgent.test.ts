/**
 * The public agent page's client (SEN-193): the route it calls with no
 * session, a parse that refuses half an answer, the errors it names, the
 * share link, and where "Hire a copy" and Welcome's `?next=` may go.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fetchPublicAgent,
  hireCopyHref,
  parsePublicAgent,
  PublicAgentError,
  publicAgentUrl,
  safeNext,
  signedMoney,
  statusPill,
} from './publicAgent.ts';

const ID = '6f1c3c1e-6c1b-4d3e-9a43-2a1f0b9d7e11';
const USDC = '0x0000000000000000000000000000000000000001';
const TX = `0x${'ab'.repeat(32)}`;

const WIRE = {
  id: ID,
  name: 'Night desk',
  sigilSeed: ID,
  owner: { name: 'Based Whale', avatarSeed: `owner/${ID}` },
  model: 'anthropic/claude-sonnet-5',
  status: 'active',
  address: '0xAbC0000000000000000000000000000000000001',
  chainId: 10143,
  erc8004AgentId: '42',
  mandate: {
    version: 1,
    chainId: 10143,
    expiresAt: 4_000_000_000,
    venues: ['kuru'],
    kuru: {
      markets: ['0x00000000000000000000000000000000000000aa'],
      maxDepositAtoms: { [USDC]: '5' },
    },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '250',
  },
  returnsToOwner: true,
  mandateSince: '2026-10-01T10:00:00.000Z',
  mandateAnchor: {
    mandateHash: `0x${'cd'.repeat(32)}`,
    txHash: TX,
    chainId: 10143,
    registry: '0x00000000000000000000000000000000000000bb',
    agentTokenId: '42',
  },
  createdAt: '2026-10-01T10:00:00.000Z',
  revokedAt: null,
  preset: null,
  forkedFrom: null,
  copies: 2,
  prompt: null,
  pnl: { allTime: '12.5', last24h: '-1', allTimePartial: false },
  counts: { trades: 1, held: 1, theses: 0 },
  balance: { approxUsd: '512.40', note: 'n' },
  fills: [
    { venue: 'kuru', symbol: 'MON-USDC', side: 'buy', price: '0.5', size: '10', txHash: TX, at: 1 },
    { symbol: 'broken' },
  ],
  refusals: [{ layer: 'enclave', code: 'policy_violation', message: 'refused', at: 2 }],
  generatedAt: '2026-10-12T12:00:00.000Z',
};

test('parses the answer, bigint atoms included, and drops malformed rows', () => {
  const agent = parsePublicAgent(WIRE);
  assert.equal(agent.name, 'Night desk');
  assert.equal(agent.mandate.kuru.maxDepositAtoms[USDC], 5n);
  assert.equal(agent.mandateAnchor?.txHash, TX);
  assert.equal(agent.fills.length, 1);
  assert.equal(agent.refusals[0]!.layer, 'enclave');
  assert.equal(agent.copies, 2);
  assert.equal(agent.prompt, null);
});

test('refuses an answer without its name or mandate', () => {
  assert.throws(() => parsePublicAgent({ ...WIRE, name: undefined }), PublicAgentError);
  assert.throws(() => parsePublicAgent({ ...WIRE, mandate: null }), PublicAgentError);
  assert.throws(() => parsePublicAgent([]), PublicAgentError);
});

test('reads a missing anchor as none, not as an error', () => {
  assert.equal(parsePublicAgent({ ...WIRE, mandateAnchor: null }).mandateAnchor, null);
  assert.equal(parsePublicAgent({ ...WIRE, mandateAnchor: { txHash: TX } }).mandateAnchor, null);
});

test('GETs /public/agents/:id with no authorization header', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(WIRE), { status: 200 }));
  }) as typeof fetch;
  const agent = await fetchPublicAgent(ID, { baseUrl: 'http://api.test/', fetchImpl });
  assert.equal(agent.id, ID);
  assert.equal(calls[0]!.url, `http://api.test/public/agents/${ID}`);
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.has('authorization'), false);
});

test('names a 404, a 429 and an unreachable API', async () => {
  const answer = (status: number) =>
    (() => Promise.resolve(new Response('{}', { status }))) as unknown as typeof fetch;
  await assert.rejects(fetchPublicAgent(ID, { fetchImpl: answer(404) }), { status: 404 });
  await assert.rejects(fetchPublicAgent(ID, { fetchImpl: answer(429) }), { status: 429 });
  const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
  await assert.rejects(fetchPublicAgent(ID, { fetchImpl: down }), { status: 0 });
});

test('the share link is /a/<id> on the given origin, sente.lol by default', () => {
  assert.equal(publicAgentUrl(ID, 'http://localhost:8081/'), `http://localhost:8081/a/${ID}`);
  assert.equal(publicAgentUrl(ID), `https://sente.lol/a/${ID}`);
});

test('Hire a copy forks when signed in, and goes through Welcome when not', () => {
  const agent = { id: ID, name: 'Night desk' };
  assert.deepEqual(hireCopyHref(agent, true), {
    pathname: '/agents/new',
    params: { fork: ID, from: 'Night desk' },
  });
  const out = hireCopyHref(agent, false);
  assert.equal(out.pathname, '/welcome');
  assert.equal(safeNext(out.params['next']), `/agents/new?fork=${ID}&from=Night%20desk`);
});

test('Welcome follows only an in-app next', () => {
  assert.equal(safeNext('/agents/new?fork=x'), '/agents/new?fork=x');
  assert.equal(safeNext('//evil.example'), null);
  assert.equal(safeNext('https://evil.example'), null);
  assert.equal(safeNext('/\\evil.example'), null);
  assert.equal(safeNext(undefined), null);
});

test('money and status read the way the page draws them', () => {
  assert.deepEqual(signedMoney('12.5'), { text: '+12.50', tone: 'up' });
  assert.deepEqual(signedMoney('-3.1'), { text: '−3.10', tone: 'down' });
  assert.deepEqual(signedMoney('0'), { text: '0.00', tone: null });
  assert.equal(statusPill('expired').tone, 'idle');
  assert.equal(statusPill('revoked').tone, 'revoked');
});
