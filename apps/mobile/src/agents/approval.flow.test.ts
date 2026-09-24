/**
 * The device-owned amend and revoke end to end on the phone side (SEN-44),
 * against a recording `fetch`: prepare, verify, sign, commit.
 *
 * `approval.test.ts` covers what the check refuses. This covers the flow around
 * it — that the signature goes to the right route with the prepare id, that the
 * mandate is not resent at commit, and, most importantly, that a payload the
 * check rejects is never signed and never committed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileMandate, compileRevocationRules, parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import type { SessionAuth } from '../wallet/api.ts';
import { AgentsApi, toWireMandate, type Agent, type AgentMandate, type WireAgent } from './api.ts';
import {
  amendMandateWithApproval,
  MandateApprovalRefusedError,
  needsApproval,
  NoDeviceKeyError,
  revokeWithApproval,
} from './approval.ts';

const BASE = 'http://api.test';
const AGENT_ID = '5b0f8a62-3c1e-4d7a-9f0e-2a6b7c8d9e01';
const POLICY_ID = 'policy-1';
const PREPARE_ID = '0d2b0f6a-1f2b-4a8c-9d10-3e4f5a6b7c8d';
const USDC = KURU_TESTNET_TOKENS.USDC.address as Address;
/** The owner's own wallet: where this agent's funds may go, and nowhere else. */
const OWNER = getAddress(`0x${'c'.repeat(40)}`);

const MANDATE: AgentMandate = {
  version: 1,
  chainId: 10143,
  expiresAt: 2_000_000_000,
  venues: ['kuru'],
  kuru: { markets: [KURU_TESTNET_MARKETS[0]!.address], maxDepositAtoms: { [USDC]: 250_000_000n } },
  perpl: { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] },
  maxOrderNotional: '50',
  // Set by the API from the signed-in account (SEN-17), so every mandate the app
  // holds in practice carries one.
  returnTo: OWNER,
};

const WIRE_AGENT: WireAgent = {
  id: AGENT_ID,
  name: 'Night desk',
  systemPrompt: '',
  strategy: '',
  model: 'anthropic/claude-sonnet-5',
  mandate: toWireMandate(MANDATE),
  address: '0x1111111111111111111111111111111111111111',
  chainId: 10143,
  walletId: 'wallet-1',
  policyId: POLICY_ID,
  status: 'active',
  ownerKind: 'device',
  public: false,
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-18T10:00:00.000Z',
};

const AGENT: Agent = { ...WIRE_AGENT, mandate: MANDATE };

/**
 * `null` is an empty policy; `{ revoke: m }` is what a revoke leaves — that
 * mandate's own way out (SEN-17).
 */
function rulesFor(mandate: AgentMandate | null | { revoke: AgentMandate }) {
  if (mandate === null) return [];
  return 'revoke' in mandate
    ? compileRevocationRules(parseMandate(toWireMandate(mandate.revoke)))
    : compileMandate(parseMandate(toWireMandate(mandate)));
}

/** What `/prepare` answers, built from the API's own compiler. */
function prepared(
  mandate: AgentMandate | null | { revoke: AgentMandate },
  over: Record<string, unknown> = {},
) {
  return {
    prepareId: PREPARE_ID,
    payload: {
      version: 1,
      method: 'PATCH',
      url: `https://api.privy.io/v1/policies/${POLICY_ID}`,
      body: { rules: rulesFor(mandate) },
      headers: { 'privy-app-id': 'app-1' },
      ...over,
    },
    expiresAt: '2026-09-18T10:05:00.000Z',
    summary: {
      kind: mandate === null ? 'revoke' : 'amend',
      agentId: AGENT_ID,
      agentName: 'Night desk',
      policyId: POLICY_ID,
      ruleCount: rulesFor(mandate).length,
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

/** A device key that records what it was asked to sign. */
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

test('an amend is prepare, verify, sign, commit — and the mandate is not resent', async () => {
  const next: AgentMandate = {
    ...MANDATE,
    kuru: { ...MANDATE.kuru, maxDepositAtoms: { [USDC]: 900_000_000n } },
  };
  const { api, calls } = recordingApi(
    { status: 200, body: prepared(next) },
    { status: 200, body: { ...WIRE_AGENT, mandate: toWireMandate(next) } },
  );
  const signer = recordingSigner();

  const updated = await amendMandateWithApproval(api, AGENT, next, signer.sign);

  assert.equal(calls[0]?.url, `${BASE}/agents/${AGENT_ID}/mandate/prepare`);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { mandate: toWireMandate(next) });

  assert.equal(calls[1]?.url, `${BASE}/agents/${AGENT_ID}/mandate`);
  assert.equal(calls[1]?.method, 'PATCH');
  // Only the id and the signature: the approved bytes are the ones the server
  // is holding, and a second copy of the mandate could differ from them.
  assert.deepEqual(calls[1]?.body, {
    prepareId: PREPARE_ID,
    signature: 'MEUCIQ-device-signature',
  });
  // What was signed is what came back from prepare, not something rebuilt.
  assert.deepEqual(signer.signed, [prepared(next).payload]);
  assert.equal(updated.mandate.kuru.maxDepositAtoms[USDC], 900_000_000n);
});

test('a revoke signs a PATCH that leaves only the way out', async () => {
  const { api, calls } = recordingApi(
    { status: 200, body: prepared({ revoke: MANDATE }) },
    { status: 200, body: { ...WIRE_AGENT, status: 'revoked', policyCleared: true } },
  );
  const signer = recordingSigner();

  const revoked = await revokeWithApproval(api, AGENT, signer.sign);

  assert.equal(calls[0]?.url, `${BASE}/agents/${AGENT_ID}/revoke/prepare`);
  assert.equal(calls[1]?.url, `${BASE}/agents/${AGENT_ID}/revoke`);
  assert.deepEqual(calls[1]?.body, {
    prepareId: PREPARE_ID,
    signature: 'MEUCIQ-device-signature',
  });
  // Not `rules: []`: what is signed leaves the withdraw and the returns in place,
  // so the owner can still empty the agent afterwards.
  const signedRules = (signer.signed[0] as { body: { rules: { name: string }[] } }).body.rules;
  assert.deepEqual(signedRules, rulesFor({ revoke: MANDATE }));
  assert.ok(signedRules.some((rule) => rule.name.startsWith('Return ')));
  assert.equal(revoked.status, 'revoked');
});

test('a prepared change that does not match is never signed and never committed', async () => {
  const typed: AgentMandate = MANDATE;
  // The server answers with a policy compiled from a larger cap.
  const widened: AgentMandate = {
    ...MANDATE,
    kuru: { ...MANDATE.kuru, maxDepositAtoms: { [USDC]: 9_000_000_000n } },
  };
  const { api, calls } = recordingApi({ status: 200, body: prepared(widened) });
  const signer = recordingSigner();

  await assert.rejects(
    amendMandateWithApproval(api, AGENT, typed, signer.sign),
    MandateApprovalRefusedError,
  );
  assert.deepEqual(signer.signed, [], 'nothing was signed');
  assert.equal(calls.length, 1, 'no commit was sent');
});

test('a revoke that would leave the agent able to trade is refused before signing', async () => {
  const { api, calls } = recordingApi({ status: 200, body: prepared(MANDATE) });
  const signer = recordingSigner();

  await assert.rejects(revokeWithApproval(api, AGENT, signer.sign), MandateApprovalRefusedError);
  assert.deepEqual(signer.signed, []);
  assert.equal(calls.length, 1);
});

test('a prepared change already on screen is the one signed, not a fresh one', async () => {
  // The confirmation sheet asked for it; approving must not prepare again, or
  // the user would read one change and sign another.
  const { api, calls } = recordingApi({ status: 200, body: WIRE_AGENT });
  const signer = recordingSigner();
  const onScreen = prepared(MANDATE) as never;

  await amendMandateWithApproval(api, AGENT, MANDATE, signer.sign, onScreen);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${BASE}/agents/${AGENT_ID}/mandate`);
});

test('no device key means no request at all', async () => {
  const { api, calls } = recordingApi();
  await assert.rejects(amendMandateWithApproval(api, AGENT, MANDATE, null), NoDeviceKeyError);
  await assert.rejects(revokeWithApproval(api, AGENT, null), NoDeviceKeyError);
  assert.equal(calls.length, 0);
});

test('needsApproval reads the API’s ownerKind, and an API without one is server-owned', () => {
  assert.equal(needsApproval({ ownerKind: 'device' }), true);
  assert.equal(needsApproval({ ownerKind: 'server' }), false);
  assert.equal(needsApproval({}), false);
});
