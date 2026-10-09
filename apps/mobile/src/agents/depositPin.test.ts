/**
 * The pinning amend after a hire (SEN-188), against a recording `fetch` and the
 * API's own compiler: that a device-owned agent goes prepare → verify → sign →
 * commit with the SAME mandate, that the phone accepts only a deposit pinned to
 * this agent's own wallet, and that the hire flow runs it between the hire and
 * the funding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileMandate, parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import type { SessionAuth } from '../wallet/api.ts';
import {
  AgentsApi,
  toWireMandate,
  type Agent,
  type AgentMandate,
  type HireAgentResult,
  type WireAgent,
} from './api.ts';
import { needsDepositPin, secureDeposits, type DepositPinState } from './depositPin.ts';
import { hireThenFund, type FundingState } from './initialFunding.ts';
import { KURU_TOKENS } from './mandate.ts';

const BASE = 'http://api.test';
const AGENT_ID = '5b0f8a62-3c1e-4d7a-9f0e-2a6b7c8d9e01';
const POLICY_ID = 'policy-1';
const PREPARE_ID = '0d2b0f6a-1f2b-4a8c-9d10-3e4f5a6b7c8d';
const USDC = KURU_TESTNET_TOKENS.USDC.address as Address;
const OWNER = getAddress(`0x${'c'.repeat(40)}`);
const AGENT_WALLET = getAddress(`0x${'1'.repeat(40)}`);
/** Anyone else: a compromised API pinning deposits to its own Kuru account. */
const ATTACKER = getAddress(`0x${'a'.repeat(40)}`);

const MANDATE: AgentMandate = {
  version: 1,
  chainId: 10143,
  expiresAt: 2_000_000_000,
  venues: ['kuru'],
  kuru: { markets: [KURU_TESTNET_MARKETS[0]!.address], maxDepositAtoms: { [USDC]: 250_000_000n } },
  perpl: { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] },
  maxOrderNotional: '50',
  returnTo: OWNER,
};

const WIRE_AGENT: WireAgent = {
  id: AGENT_ID,
  name: 'Night desk',
  systemPrompt: '',
  strategy: '',
  model: 'anthropic/claude-sonnet-5',
  mandate: toWireMandate(MANDATE),
  address: AGENT_WALLET,
  chainId: 10143,
  walletId: 'wallet-1',
  policyId: POLICY_ID,
  status: 'active',
  kuruDepositPinned: false,
  ownerKind: 'device',
  public: false,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
};

const AGENT: Agent = { ...WIRE_AGENT, mandate: MANDATE };

/** What `/mandate/prepare` answers, with the deposit pinned to `pin` (or not at all). */
function prepared(pin: Address | null) {
  const rules = compileMandate(parseMandate(toWireMandate(MANDATE)), { agentAddress: pin });
  return {
    prepareId: PREPARE_ID,
    payload: {
      version: 1,
      method: 'PATCH',
      url: `https://api.privy.io/v1/policies/${POLICY_ID}`,
      body: { rules },
      headers: { 'privy-app-id': 'app-1' },
    },
    expiresAt: '2026-10-09T10:05:00.000Z',
    summary: {
      kind: 'amend',
      agentId: AGENT_ID,
      agentName: 'Night desk',
      policyId: POLICY_ID,
      ruleCount: rules.length,
    },
  };
}

type Reply = { status: number; body?: unknown };
type Recorded = { url: string; method: string; body?: unknown };

function recordingApi(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const auth: SessionAuth = { token: () => 'v1.token', refresh: () => Promise.resolve('v1.token') };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  }) as typeof fetch;
  return { api: new AgentsApi({ auth, baseUrl: BASE, fetchImpl }), calls };
}

function recordingSigner() {
  const signed: unknown[] = [];
  return {
    signed,
    sign: (payload: unknown) => {
      signed.push(payload);
      return 'MEUCIQ-device-signature';
    },
  };
}

test('needsDepositPin: only an active agent the API says is unpinned', () => {
  assert.equal(needsDepositPin({ status: 'active', kuruDepositPinned: false }), true);
  assert.equal(needsDepositPin({ status: 'active', kuruDepositPinned: true }), false);
  // An API that predates SEN-188 says nothing: nothing to do.
  assert.equal(needsDepositPin({ status: 'active' }), false);
  assert.equal(needsDepositPin({ status: 'revoked', kuruDepositPinned: false }), false);
});

test('a device-owned agent is pinned by the same-mandate amend, signed on this phone', async () => {
  const { api, calls } = recordingApi(
    { status: 200, body: prepared(AGENT_WALLET) },
    { status: 200, body: { ...WIRE_AGENT, kuruDepositPinned: true } },
  );
  const signer = recordingSigner();

  const state = await secureDeposits({
    api,
    agent: AGENT,
    mandate: MANDATE,
    ownWallet: OWNER,
    sign: signer.sign,
  });

  assert.equal(state.kind, 'secured');
  assert.equal(state.kind === 'secured' ? state.agent.kuruDepositPinned : null, true);
  assert.equal(calls[0]?.url, `${BASE}/agents/${AGENT_ID}/mandate/prepare`);
  // The mandate the phone holds, unchanged: the amend changes the policy, not the terms.
  assert.deepEqual(calls[0]?.body, { mandate: toWireMandate(MANDATE) });
  assert.equal(calls[1]?.url, `${BASE}/agents/${AGENT_ID}/mandate`);
  assert.deepEqual(calls[1]?.body, { prepareId: PREPARE_ID, signature: 'MEUCIQ-device-signature' });
  assert.deepEqual(signer.signed, [prepared(AGENT_WALLET).payload]);
});

test('a pin to anyone but this agent’s wallet is never signed', async () => {
  for (const pin of [ATTACKER, null]) {
    const { api, calls } = recordingApi({ status: 200, body: prepared(pin) });
    const signer = recordingSigner();

    const state = await secureDeposits({
      api,
      agent: AGENT,
      mandate: MANDATE,
      ownWallet: OWNER,
      sign: signer.sign,
    });

    assert.equal(state.kind, 'failed', String(pin));
    assert.equal(state.kind === 'failed' ? state.title : '', 'This phone refused to sign it');
    assert.match(state.kind === 'failed' ? state.detail : '', /Kuru: deposit USDC/);
    assert.deepEqual(signer.signed, [], 'nothing was signed');
    assert.equal(calls.length, 1, 'no commit was sent');
  }
});

test('no device key: failed, and no request at all', async () => {
  const { api, calls } = recordingApi();
  const state = await secureDeposits({
    api,
    agent: AGENT,
    mandate: MANDATE,
    ownWallet: OWNER,
    sign: null,
  });
  assert.equal(state.kind, 'failed');
  assert.equal(calls.length, 0);
});

test('a server-owned agent takes the one-step amend', async () => {
  const { api, calls } = recordingApi({
    status: 200,
    body: { ...WIRE_AGENT, ownerKind: 'server', kuruDepositPinned: true },
  });
  const state = await secureDeposits({
    api,
    agent: { ...AGENT, ownerKind: 'server' },
    mandate: MANDATE,
    ownWallet: OWNER,
    sign: null,
  });
  assert.equal(state.kind, 'secured');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PATCH');
  assert.deepEqual(calls[0]?.body, { mandate: toWireMandate(MANDATE) });
});

test('an amend the API still reports unpinned is not called secured', async () => {
  const { api } = recordingApi({ status: 200, body: { ...WIRE_AGENT, ownerKind: 'server' } });
  const state = await secureDeposits({
    api,
    agent: { ...AGENT, ownerKind: 'server' },
    mandate: MANDATE,
    ownWallet: OWNER,
    sign: null,
  });
  assert.equal(state.kind, 'failed');
});

const USDC_TOKEN = KURU_TOKENS.find((token) => token.symbol === 'USDC')!;

function hireSteps(agent: Agent, secured: DepositPinState) {
  const order: string[] = [];
  const pins: DepositPinState[] = [];
  const funding: FundingState[] = [];
  const run = () =>
    hireThenFund({
      hire: async (): Promise<HireAgentResult> => {
        order.push('hire');
        return { agent, mcpToken: 't' };
      },
      funding: { token: USDC_TOKEN, atoms: 25_000_000n },
      fund: async () => {
        order.push('fund');
        return { kind: 'sent', label: '25 USDC' };
      },
      onHired: () => order.push('hired'),
      onFunding: (state) => funding.push(state),
      secure: async (hired) => {
        order.push(`secure ${hired.address}`);
        return secured;
      },
      onSecure: (state) => pins.push(state),
    });
  return { order, pins, funding, run };
}

test('the hire flow: hire, then secure the deposits, then fund', async () => {
  const secured: DepositPinState = {
    kind: 'secured',
    agent: { ...AGENT, kuruDepositPinned: true },
  };
  const steps = hireSteps(AGENT, secured);
  await steps.run();
  assert.deepEqual(steps.order, ['hire', 'hired', `secure ${AGENT_WALLET}`, 'fund']);
  assert.deepEqual(steps.pins, [{ kind: 'securing' }, secured]);
});

test('a failed pin leaves the hire standing and the funding still runs', async () => {
  const failed: DepositPinState = { kind: 'failed', title: 'Network', detail: 'down' };
  const steps = hireSteps(AGENT, failed);
  await steps.run();
  assert.deepEqual(steps.pins, [{ kind: 'securing' }, failed]);
  assert.equal(steps.order.at(-1), 'fund');
  assert.equal(steps.funding.at(-1)?.kind, 'sent');
});

test('nothing to pin (the API says pinned): no secure step at all', async () => {
  const steps = hireSteps({ ...AGENT, kuruDepositPinned: true }, { kind: 'securing' });
  await steps.run();
  assert.deepEqual(steps.order, ['hire', 'hired', 'fund']);
  assert.deepEqual(steps.pins, []);
});
