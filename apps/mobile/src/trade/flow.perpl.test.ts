/**
 * Perpl setup on the phone (SEN-104): onboarding and key enrollment against a
 * fake API and a recording signer. Plain node, no device, no network.
 *
 * The fake server composes steps with `@sente/venues/perpl`'s own
 * `perplOnboardingCalls` and enrollment items in the live P5 spellings
 * (docs/user-trading.md §P5), so the happy paths are what the server really
 * sends. The refusal cases assert the property the flows exist for: a refused
 * check signs nothing and commits nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  PERPL_API_KEY_TYPED_DATA,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
  type PerplOnboardingParams,
} from '@sente/venues/perpl';
import { getAddress, type Address, type Hex } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { perplTradeKey, type PerplTradeKey } from '../auth/perplKey.ts';
import { NoDeviceKeyError } from '../auth/privyApproval.ts';
import type { Erc7579Call } from '../wallet/batch.ts';
import { TradeApiError } from './api.ts';
import { tradeIdempotencyKey } from './envelope.ts';
import {
  PERPL_TRADE_KEY_ENROLL_LABEL,
  perplApiKeyOf,
  perplReady,
  perplSetupNeeds,
  runPerplEnrollment,
  runPerplOnboard,
  TradeApprovalRefusedError,
  type PerplEnrollApi,
  type TradeFlowApi,
} from './flow.ts';
import type {
  EnrollCommitRequest,
  EnrollPrepareRequest,
  EnrollPrepareResult,
  EnrollRole,
  PerplAccount,
  PerplOnboardIntent,
  PerplTypedData,
  PreparedStep,
  PreparedTrade,
  StepKind,
  TradeIntent,
  TradeView,
} from './types.ts';
import { enrollIdempotencyKey, PERPL_READ_KEY_LABEL } from './verifyPerpl.ts';

const WALLET_ID = 'wallet00000000000000test';
const WALLET = getAddress('0x7777777777777777777777777777777777777777');
const CTX = { walletId: WALLET_ID, wallet: WALLET };
const TRADE_ID = '4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f';
const PREPARE_ID = '9c3e1a2b-4d5f-4a6b-8c7d-0e1f2a3b4c5d';
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const MIN = 100_000_000n;

const PARAMS: PerplOnboardingParams = {
  exchange: PERPL_TESTNET_CONTRACTS.exchange,
  collateral: PERPL_TESTNET_CONTRACTS.collateral,
  collateralDecimals: 6,
  minAccountOpenAmount: MIN,
  minDepositAmount: 10_000_000n,
};

const noSleep = () => Promise.resolve();
const FLOW_OPTS = { newClientTradeId: () => TRADE_ID, sleep: noSleep };

// ---------------------------------------------------------------------------
// Setup needs.

const account = (over: Partial<PerplAccount> = {}): PerplAccount => ({
  accountId: '1028',
  forwarding: true,
  minOpenAtoms: MIN.toString(),
  readKey: 'linked',
  apiKey: 'tok',
  ...over,
});

test('no account: open (with forwarding) and enroll', () => {
  const needs = perplSetupNeeds(
    account({ accountId: null, forwarding: false, apiKey: undefined }),
    null,
  );
  assert.deepEqual(needs, { open: true, forwarding: false, enroll: true });
  assert.equal(perplReady(needs), false);
});

test('an open account the server has not seen forward: forwarding alone, then enroll', () => {
  const needs = perplSetupNeeds(account({ forwarding: false, apiKey: undefined }), null);
  assert.deepEqual(needs, { open: false, forwarding: true, enroll: true });
});

test('after an API restart an enrolled account reads forwarding false: ready, nothing re-sent', () => {
  const needs = perplSetupNeeds(account({ forwarding: false }), null);
  assert.deepEqual(needs, { open: false, forwarding: false, enroll: false });
  assert.equal(perplReady(needs), true);
});

test('the phone’s own token counts when the server lost its copy', () => {
  const lost = account({ apiKey: undefined, readKey: 'unlinked' });
  assert.equal(perplReady(perplSetupNeeds(lost, 'kept')), true);
  assert.equal(perplApiKeyOf(lost, 'kept'), 'kept');
  assert.equal(perplApiKeyOf(account(), 'kept'), 'tok', 'the server’s token wins');
  assert.equal(perplApiKeyOf(lost, null), null);
});

// ---------------------------------------------------------------------------
// Onboarding.

const [APPROVE, CREATE, FORWARD] = perplOnboardingCalls(PARAMS, 150_000_000n);

function stepPayload(index: number, call: Erc7579Call): AuthorizationPayload {
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: {
      'privy-app-id': 'app-id-test',
      'privy-idempotency-key': tradeIdempotencyKey(TRADE_ID, index),
    },
    body: {
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      params: {
        transaction: { to: getAddress(call.to), data: call.data ?? '0x', chain_id: 10143 },
      },
    },
  };
}

function steps(legs: readonly [StepKind, Erc7579Call][]): PreparedStep[] {
  return legs.map(([kind, call], index) => ({
    index,
    kind,
    title: kind,
    payload: stepPayload(index, call),
  }));
}

const FRESH: [StepKind, Erc7579Call][] = [
  ['perpl.approve', APPROVE!],
  ['perpl.createAccount', CREATE!],
  ['perpl.allowForwarding', FORWARD!],
];
const FORWARD_ONLY: [StepKind, Erc7579Call][] = [['perpl.allowForwarding', FORWARD!]];

function onboardApi(planned: PreparedStep[] | Error) {
  const seen = { prepared: [] as TradeIntent[], commits: 0 };
  const view = (status: TradeView['status']): TradeView => ({
    tradeId: 'server-trade-1',
    clientTradeId: TRADE_ID,
    kind: 'perpl.onboard',
    status,
    steps: [],
    updatedAt: new Date(NOW).toISOString(),
  });
  const api: TradeFlowApi = {
    prepare: async (intent): Promise<PreparedTrade> => {
      seen.prepared.push(intent);
      if (planned instanceof Error) throw planned;
      return {
        tradeId: 'server-trade-1',
        clientTradeId: intent.clientTradeId,
        expiresAt: new Date(NOW + 300_000).toISOString(),
        wallet: { walletId: WALLET_ID, address: WALLET },
        steps: planned,
        summary: {},
      };
    },
    commit: async () => {
      seen.commits += 1;
      return view('completed');
    },
    status: async () => view('completed'),
  };
  return { api, seen };
}

function recordingSigner() {
  const signed: AuthorizationPayload[] = [];
  return { signed, sign: (p: AuthorizationPayload) => (signed.push(p), `sig${signed.length}`) };
}

test('a fresh onboarding: verifies all three steps, signs each, commits, completes', async () => {
  const { api, seen } = onboardApi(steps(FRESH));
  const { signed, sign } = recordingSigner();
  const phases: string[] = [];
  const outcome = await runPerplOnboard(
    api,
    { amountAtoms: '150000000' },
    { ...CTX, accountOpen: false },
    sign,
    (s) => phases.push(s.phase),
    FLOW_OPTS,
  );
  assert.equal(outcome.status, 'completed');
  assert.equal(signed.length, 3);
  assert.equal(seen.commits, 1);
  assert.deepEqual(seen.prepared[0], {
    kind: 'perpl.onboard',
    clientTradeId: TRADE_ID,
    amountAtoms: '150000000',
  } satisfies PerplOnboardIntent);
  assert.deepEqual(phases, [
    'preparing',
    'verifying',
    'signing',
    'committing',
    'following',
    'settled',
  ]);
});

test('a refused check signs nothing and commits nothing', async () => {
  // The server opens the account with more than the user confirmed.
  const [, bigger] = perplOnboardingCalls(PARAMS, 500_000_000n);
  const { api, seen } = onboardApi(steps([FRESH[0]!, ['perpl.createAccount', bigger!], FRESH[2]!]));
  const { signed, sign } = recordingSigner();
  await assert.rejects(
    runPerplOnboard(
      api,
      { amountAtoms: '150000000' },
      { ...CTX, accountOpen: false },
      sign,
      () => undefined,
      FLOW_OPTS,
    ),
    TradeApprovalRefusedError,
  );
  assert.equal(signed.length, 0);
  assert.equal(seen.commits, 0);
});

test('resume: an open account signs only allowOrderForwarding, at the minimum amount', async () => {
  const { api, seen } = onboardApi(steps(FORWARD_ONLY));
  const { signed, sign } = recordingSigner();
  const outcome = await runPerplOnboard(
    api,
    { amountAtoms: '0' },
    { ...CTX, accountOpen: true },
    sign,
    () => undefined,
    FLOW_OPTS,
  );
  assert.equal(outcome.status, 'completed');
  assert.equal(signed.length, 1);
  assert.equal((seen.prepared[0] as PerplOnboardIntent).amountAtoms, MIN.toString());
});

test('resume: an open account refuses a plan that would open it again', async () => {
  // A plan the verifier alone would pass: it opens at exactly the amount sent.
  const [approve, create, forward] = perplOnboardingCalls(PARAMS, MIN);
  const { api, seen } = onboardApi(
    steps([
      ['perpl.approve', approve!],
      ['perpl.createAccount', create!],
      ['perpl.allowForwarding', forward!],
    ]),
  );
  const { signed, sign } = recordingSigner();
  await assert.rejects(
    runPerplOnboard(
      api,
      { amountAtoms: '150000000' },
      { ...CTX, accountOpen: true },
      sign,
      () => undefined,
      FLOW_OPTS,
    ),
    (e: unknown) => e instanceof TradeApprovalRefusedError && /already open/.test(e.problem),
  );
  assert.equal(signed.length, 0);
  assert.equal(seen.commits, 0);
});

test('resume: nothing left to sign on the server is not an error', async () => {
  const { api } = onboardApi(new TradeApiError(409, 'perpl_already_onboarded', 'nothing to sign'));
  const { signed, sign } = recordingSigner();
  const outcome = await runPerplOnboard(
    api,
    { amountAtoms: '0' },
    { ...CTX, accountOpen: true },
    sign,
    () => undefined,
    FLOW_OPTS,
  );
  assert.deepEqual(outcome, { status: 'already_onboarded' });
  assert.equal(signed.length, 0);
});

test('signed out: refuses before asking the server', async () => {
  const { api, seen } = onboardApi(steps(FRESH));
  await assert.rejects(
    runPerplOnboard(
      api,
      { amountAtoms: '150000000' },
      { ...CTX, accountOpen: false },
      null,
      () => undefined,
    ),
    NoDeviceKeyError,
  );
  assert.equal(seen.prepared.length, 0);
});

// ---------------------------------------------------------------------------
// Enrollment.

const DEVICE_KEY = new Uint8Array(32).fill(7);
const READ_KEY: Hex = `0x${'ab'.repeat(32)}`;

const perplKeyField = (hex: Hex): string => Buffer.from(hex.slice(2), 'hex').toString('base64url');

/** Perpl's payload in the P5 spellings: unpadded base64url key, effective scope, hex time. */
function served(role: EnrollRole, publicKey: Hex, label: string): PerplTypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: PERPL_API_KEY_TYPED_DATA.types.PerplRegisterApiKey.map((f) => ({
        ...f,
      })),
    },
    primaryType: 'PerplRegisterApiKey',
    domain: {
      name: 'perpl.xyz',
      version: '1',
      chainId: '0x279f',
      verifyingContract: '0x0000000000000000000000000000000000000000',
      salt: '0x00000000000000000000000000000000000000006aa3eb20368ca5c38d4d3fb0',
    },
    message: {
      signer: WALLET.toLowerCase(),
      statement: PERPL_API_KEY_TYPED_DATA.statement,
      publicKey: perplKeyField(publicKey),
      scope: role === 'trade' ? '3' : '1',
      label,
      expiresAt: '0',
      ipCidrs: '',
      origin: '',
      builderId: '0',
      maxBuilderFeePer100K: '0',
      time: `0x${NOW.toString(16)}`,
    },
  };
}

function enrollItem(role: EnrollRole, typedData: PerplTypedData) {
  const privy = {
    domain: { ...typedData.domain, chainId: Number(BigInt(typedData.domain.chainId)) },
    types: typedData.types,
    primary_type: typedData.primaryType,
    message: { ...typedData.message, time: Number(BigInt(typedData.message['time']!)) },
  };
  const payload: AuthorizationPayload = {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: {
      'privy-app-id': 'app-id-test',
      'privy-idempotency-key': enrollIdempotencyKey(PREPARE_ID, role),
    },
    body: { method: 'eth_signTypedData_v4', params: { typed_data: privy } },
  };
  return { role, payload, typedData };
}

function enrollApi(tamper: (trade: PerplTypedData) => PerplTypedData = (t) => t) {
  const seen = {
    prepares: [] as EnrollPrepareRequest[],
    commits: [] as EnrollCommitRequest[],
    tradeTyped: null as PerplTypedData | null,
  };
  const api: PerplEnrollApi = {
    enrollPrepare: async (request): Promise<EnrollPrepareResult> => {
      seen.prepares.push(request);
      const trade = tamper(served('trade', request.publicKeyHex, request.label));
      seen.tradeTyped = trade;
      return {
        prepareId: PREPARE_ID,
        expiresAt: new Date(NOW + 300_000).toISOString(),
        items: [
          enrollItem('trade', trade),
          enrollItem('read', served('read', READ_KEY, PERPL_READ_KEY_LABEL)),
        ],
      };
    },
    enrollCommit: async (request) => {
      seen.commits.push(request);
      return { apiKey: 'api-key-token', accountId: '1028', readKey: 'linked' };
    },
  };
  return { api, seen };
}

function keySource() {
  const handed: PerplTradeKey[] = [];
  const tradeKey = (wallet: Address) => {
    const key = perplTradeKey(DEVICE_KEY, wallet);
    handed.push(key);
    return key;
  };
  return { handed, tradeKey };
}

function memoryStore() {
  const saved = new Map<string, string>();
  return {
    saved,
    save: async (wallet: Address, apiKey: string) => void saved.set(wallet, apiKey),
  };
}

test('enrollment: verifies both items, signs both, proves possession, keeps the token', async () => {
  const { api, seen } = enrollApi();
  const { signed, sign } = recordingSigner();
  const { handed, tradeKey } = keySource();
  const store = memoryStore();
  const phases: string[] = [];

  const result = await runPerplEnrollment(api, CTX, { sign, tradeKey }, store, {
    now: () => NOW,
    onPhase: (p) => phases.push(p),
  });

  assert.equal(result.apiKey, 'api-key-token');
  assert.deepEqual(phases, ['preparing', 'verifying', 'signing', 'committing']);
  const expected = perplTradeKey(DEVICE_KEY, WALLET);
  assert.deepEqual(seen.prepares, [
    { publicKeyHex: expected.publicKeyHex, label: PERPL_TRADE_KEY_ENROLL_LABEL },
  ]);
  assert.equal(signed.length, 2);
  const [commit] = seen.commits;
  assert.ok(commit);
  assert.deepEqual(commit.signatures, ['sig1', 'sig2']);
  assert.equal(commit.prepareId, PREPARE_ID);

  // The proof verifies under the trade key, over the digest Perpl's verifier computes.
  const { toViemTypedData } = await import('@sente/venues/perpl');
  const { hashTypedData } = await import('viem');
  const digest = hashTypedData(toViemTypedData(seen.tradeTyped as never) as never);
  assert.ok(
    ed25519.verify(
      hexToBytes(commit.popSignature.slice(2)),
      hexToBytes(digest.slice(2)),
      hexToBytes(expected.publicKeyHex.slice(2)),
    ),
  );

  assert.equal(store.saved.get(WALLET), 'api-key-token');
  assert.equal(bytesToHex(handed[0]!.secretKey), '00'.repeat(32), 'the key copy is zeroed');
});

test('enrollment: a refused item signs nothing, commits nothing, and still zeroes the key', async () => {
  // A builder fee would skim every order placed with the key.
  const { api, seen } = enrollApi((t) => ({
    ...t,
    message: { ...t.message, maxBuilderFeePer100K: '100' },
  }));
  const { signed, sign } = recordingSigner();
  const { handed, tradeKey } = keySource();
  const store = memoryStore();
  await assert.rejects(
    runPerplEnrollment(api, CTX, { sign, tradeKey }, store, { now: () => NOW }),
    (e: unknown) =>
      e instanceof TradeApprovalRefusedError && /Perpl key enrollment/.test(e.message),
  );
  assert.equal(signed.length, 0);
  assert.equal(seen.commits.length, 0);
  assert.equal(store.saved.size, 0);
  assert.equal(bytesToHex(handed[0]!.secretKey), '00'.repeat(32));
});

test('enrollment: a payload for another key is refused', async () => {
  const other: Hex = `0x${'cd'.repeat(32)}`;
  const { api, seen } = enrollApi((t) => ({
    ...t,
    message: { ...t.message, publicKey: perplKeyField(other) },
  }));
  const { signed, sign } = recordingSigner();
  await assert.rejects(
    runPerplEnrollment(api, CTX, { sign, tradeKey: keySource().tradeKey }, memoryStore(), {
      now: () => NOW,
    }),
    TradeApprovalRefusedError,
  );
  assert.equal(signed.length, 0);
  assert.equal(seen.commits.length, 0);
});

test('enrollment: a store that fails does not fail the enrollment', async () => {
  const { api } = enrollApi();
  const result = await runPerplEnrollment(
    api,
    CTX,
    { sign: recordingSigner().sign, tradeKey: keySource().tradeKey },
    { save: () => Promise.reject(new Error('quota')) },
    { now: () => NOW },
  );
  assert.equal(result.apiKey, 'api-key-token');
});

test('enrollment: signed out refuses before deriving or asking', async () => {
  const { api, seen } = enrollApi();
  await assert.rejects(
    runPerplEnrollment(api, CTX, { sign: null, tradeKey: null }, memoryStore()),
    NoDeviceKeyError,
  );
  assert.equal(seen.prepares.length, 0);
});
