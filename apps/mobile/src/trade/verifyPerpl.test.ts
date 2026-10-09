/**
 * Perpl verifier tests (SEN-98, plan M-T16). Plain node, no device, no network.
 *
 * Accepted onboarding fixtures are built with `@sente/venues/perpl`'s own
 * `perplOnboardingCalls`, and accepted enrollments in the two shapes the
 * server sends (Perpl's verbatim payload and Privy's `toPrivyTypedData` form),
 * so a pass means the phone accepts what the server sends. Then one tampered
 * case per rule: each is a way a buggy or compromised server could have got a
 * blind signature, and does not. `contract.test.ts` runs the real server code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERC20_APPROVE_ABI,
  PERPL_API_KEY_TYPED_DATA,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
  type PerplOnboardingParams,
} from '@sente/venues/perpl';
import { encodeFunctionData, getAddress, toFunctionSelector, type Address, type Hex } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { perplTradeKey } from '../auth/perplKey.ts';
import { encodeKernelExecute, type Erc7579Call } from '../wallet/batch.ts';
import { tradeIdempotencyKey } from './envelope.ts';
import type {
  EnrollPrepareItem,
  EnrollPrepareResult,
  EnrollRole,
  PerplOnboardIntent,
  PerplTypedData,
  PreparedStep,
  StepKind,
} from './types.ts';
import {
  enrollIdempotencyKey,
  PERPL_ENROLL_PINNED,
  PERPL_ONBOARD_ABI,
  PERPL_READ_KEY_LABEL,
  verifyEnrollment,
  verifyEnrollmentPrepare,
  verifyPerplOnboard,
  type EnrollVerifyContext,
  type PerplVerifyResult,
} from './verifyPerpl.ts';

const WALLET_ID = 'wallet00000000000000test';
const WALLET = getAddress('0x7777777777777777777777777777777777777777');
const TRADE_ID = '4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f';
const STRANGER = getAddress('0x1111111111111111111111111111111111111111');
const { exchange: EXCHANGE, collateral: AUSD } = PERPL_TESTNET_CONTRACTS;
const MIN = 100_000_000n;
const AMOUNT = 150_000_000n;

const PARAMS: PerplOnboardingParams = {
  exchange: EXCHANGE,
  collateral: AUSD,
  collateralDecimals: 6,
  minAccountOpenAmount: MIN,
  minDepositAmount: 10_000_000n,
};

const INTENT: PerplOnboardIntent = {
  kind: 'perpl.onboard',
  clientTradeId: TRADE_ID,
  amountAtoms: AMOUNT.toString(),
};

// ---------------------------------------------------------------------------
// Onboarding fixtures.

const [APPROVE_CALL, CREATE_CALL, FORWARD_CALL] = perplOnboardingCalls(PARAMS, AMOUNT);

const approveCall = (amount: bigint, spender: Address = EXCHANGE, token: Address = AUSD) => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [spender, amount],
  }),
});
const createCall = (amount: bigint, to: Address = EXCHANGE): Erc7579Call => ({
  to,
  value: 0n,
  data: encodeFunctionData({
    abi: PERPL_EXCHANGE_ABI,
    functionName: 'createAccount',
    args: [amount],
  }),
});

/** What the server signs for one step, as `sponsoredSendBody(sponsoredCallTransaction(...))`. */
function payload(index: number, calls: readonly Erc7579Call[]): AuthorizationPayload {
  const [first] = calls;
  assert.ok(first);
  const direct = calls.length === 1;
  const value = direct ? (first.value ?? 0n) : 0n;
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
        transaction: {
          to: getAddress(direct ? first.to : WALLET),
          data: direct ? (first.data ?? '0x') : encodeKernelExecute(calls),
          ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
          chain_id: 10143,
        },
      },
    },
  };
}

const KIND_BY_CALL = new Map<Erc7579Call, StepKind>([
  [APPROVE_CALL, 'perpl.approve'],
  [CREATE_CALL, 'perpl.createAccount'],
  [FORWARD_CALL, 'perpl.allowForwarding'],
]);

/** One step per call, labelled by what the call is (or by `kinds`). */
function separate(calls: readonly Erc7579Call[], kinds?: readonly StepKind[]): PreparedStep[] {
  return calls.map((call, index) => ({
    index,
    kind: kinds?.[index] ?? KIND_BY_CALL.get(call) ?? 'perpl.approve',
    title: 'step',
    payload: payload(index, [call]),
  }));
}

const batched = (calls: readonly Erc7579Call[]): PreparedStep[] => [
  { index: 0, kind: 'batch', title: 'step', payload: payload(0, calls) },
];

const onboard = (steps: readonly PreparedStep[], intent: PerplOnboardIntent = INTENT) =>
  verifyPerplOnboard(steps, { walletId: WALLET_ID, wallet: WALLET, intent });

function refused(result: PerplVerifyResult | { ok: boolean; problem?: string }, why: RegExp) {
  assert.equal(result.ok, false, 'expected a refusal');
  assert.match((result as { problem: string }).problem, why);
}

// ---------------------------------------------------------------------------
// Onboarding: what the server sends passes.

test('the onboarding allow-list matches the venue ABIs selector for selector', () => {
  const venue = [...ERC20_APPROVE_ABI, ...PERPL_EXCHANGE_ABI];
  for (const fragment of PERPL_ONBOARD_ABI) {
    const twin = venue.find((f) => f.name === fragment.name);
    assert.ok(twin, fragment.name);
    assert.equal(toFunctionSelector(fragment), toFunctionSelector(twin));
  }
});

test('signs a fresh onboarding: approve, open, forward, one step each', () => {
  assert.deepEqual(onboard(separate([APPROVE_CALL, CREATE_CALL, FORWARD_CALL])), { ok: true });
});

test('signs a fresh onboarding as one atomic batch', () => {
  assert.deepEqual(onboard(batched([APPROVE_CALL, CREATE_CALL, FORWARD_CALL])), { ok: true });
});

test('signs a resumed onboarding that only turns forwarding on', () => {
  assert.deepEqual(onboard(separate([FORWARD_CALL])), { ok: true });
});

test('signs an onboarding without the forwarding leg (forwarding already on)', () => {
  assert.deepEqual(onboard(separate([APPROVE_CALL, CREATE_CALL])), { ok: true });
});

test('signs exactly the minimum', () => {
  const [a, c] = perplOnboardingCalls(PARAMS, MIN);
  assert.deepEqual(
    onboard(separate([a, c], ['perpl.approve', 'perpl.createAccount']), {
      ...INTENT,
      amountAtoms: MIN.toString(),
    }),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// Onboarding: one tamper per rule.

test('refuses an account opened with another amount than confirmed', () => {
  const steps = separate(
    [approveCall(AMOUNT * 2n), createCall(AMOUNT * 2n), FORWARD_CALL],
    ['perpl.approve', 'perpl.createAccount', 'perpl.allowForwarding'],
  );
  refused(onboard(steps), /another amount than you confirmed/);
});

test('refuses an approval larger than the deposit', () => {
  const steps = separate(
    [approveCall(AMOUNT + 1n), CREATE_CALL],
    ['perpl.approve', 'perpl.createAccount'],
  );
  refused(onboard(steps), /not exactly the deposit/);
});

test('refuses an unlimited approval', () => {
  const steps = separate(
    [approveCall(2n ** 256n - 1n), CREATE_CALL],
    ['perpl.approve', 'perpl.createAccount'],
  );
  refused(onboard(steps), /not exactly the deposit/);
});

test('refuses a confirmed amount below the 100 AUSD minimum', () => {
  refused(
    onboard(separate([FORWARD_CALL]), { ...INTENT, amountAtoms: (MIN - 1n).toString() }),
    /below the 100 AUSD/,
  );
});

test('refuses an approval to another spender', () => {
  const steps = separate(
    [approveCall(AMOUNT, STRANGER), CREATE_CALL],
    ['perpl.approve', 'perpl.createAccount'],
  );
  refused(onboard(steps), /not the Perpl Exchange/);
});

test('refuses an approval of another token', () => {
  const steps = separate(
    [approveCall(AMOUNT, EXCHANGE, STRANGER), CREATE_CALL],
    ['perpl.approve', 'perpl.createAccount'],
  );
  refused(onboard(steps), /not AUSD/);
});

test('refuses createAccount sent to another target', () => {
  const steps = separate(
    [APPROVE_CALL, createCall(AMOUNT, STRANGER)],
    ['perpl.approve', 'perpl.createAccount'],
  );
  refused(onboard(steps), /not the Perpl Exchange/);
});

test('refuses allowOrderForwarding sent to another target', () => {
  const steps = separate([{ ...FORWARD_CALL, to: STRANGER }], ['perpl.allowForwarding']);
  refused(onboard(steps), /not the Perpl Exchange/);
});

test('refuses turning forwarding off', () => {
  const off = {
    to: EXCHANGE,
    value: 0n,
    data: encodeFunctionData({
      abi: PERPL_EXCHANGE_ABI,
      functionName: 'allowOrderForwarding',
      args: [false],
    }),
  };
  refused(onboard(separate([off], ['perpl.allowForwarding'])), /forwarding off/);
});

test('refuses any other Exchange function', () => {
  const deposit = {
    to: EXCHANGE,
    value: 0n,
    data: encodeFunctionData({
      abi: PERPL_EXCHANGE_ABI,
      functionName: 'depositCollateral',
      args: [AMOUNT],
    }),
  };
  refused(onboard(separate([deposit], ['perpl.allowForwarding'])), /not a Perpl onboarding call/);
});

test('refuses value on any leg', () => {
  refused(onboard(separate([{ ...FORWARD_CALL, value: 1n }])), /carries value/);
});

test('refuses an approval nothing consumes', () => {
  refused(onboard(separate([APPROVE_CALL, FORWARD_CALL])), /not followed by opening/);
});

test('refuses opening without the approval', () => {
  refused(onboard(separate([CREATE_CALL, FORWARD_CALL])), /without approving/);
});

test('refuses legs out of order', () => {
  refused(onboard(separate([CREATE_CALL, APPROVE_CALL])), /out of place/);
  refused(onboard(separate([FORWARD_CALL, APPROVE_CALL, CREATE_CALL])), /out of place/);
});

test('refuses a repeated leg', () => {
  refused(onboard(separate([FORWARD_CALL, FORWARD_CALL])), /out of place/);
});

test('refuses a step labelled as something it is not', () => {
  refused(
    onboard(
      separate([APPROVE_CALL, CREATE_CALL], ['perpl.allowForwarding', 'perpl.createAccount']),
    ),
    /labelled/,
  );
});

test('refuses another step index or idempotency key', () => {
  const [step] = separate([FORWARD_CALL]);
  refused(onboard([{ ...step!, index: 1 }]), /claims to be step 1/);
  const other = { ...INTENT, clientTradeId: '0b7a5c4e-2f1d-4c3b-9a8e-7d6c5b4a3f21' };
  refused(onboard([step!], other), /idempotency key/);
});

test('refuses a trade id that is not a UUID, a malformed amount, and no steps', () => {
  refused(onboard(separate([FORWARD_CALL]), { ...INTENT, clientTradeId: 'a:b' }), /UUID/);
  refused(onboard(separate([FORWARD_CALL]), { ...INTENT, amountAtoms: '1e9' }), /not an amount/);
  refused(onboard([]), /no steps/);
});

// ---------------------------------------------------------------------------
// Enrollment fixtures.

const PREPARE_ID = '9c3e1a2b-4d5f-4a6b-8c7d-0e1f2a3b4c5d';
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const DEVICE_KEY = new Uint8Array(32).fill(7);
const TRADE_KEY = perplTradeKey(DEVICE_KEY, WALLET).publicKeyHex;
const READ_KEY: Hex = `0x${'ab'.repeat(32)}`;
const TRADE_LABEL = 'sente-phone';

const CTX: EnrollVerifyContext = {
  walletId: WALLET_ID,
  wallet: WALLET,
  tradePublicKeyHex: TRADE_KEY,
  tradeLabel: TRADE_LABEL,
  now: NOW,
};

/** How Perpl spells a key in the message (P5): the 32 bytes as unpadded base64url. */
const perplKey = (hex: Hex): string => Buffer.from(hex.slice(2), 'hex').toString('base64url');

/**
 * Perpl's payload as served, in the spellings P5 recorded live
 * (`docs/user-trading.md` §P5; cf. `perpl-enroll.service.spec.ts`'s
 * `servedPayload`). Literal values, not the pin, so a wrong pin fails here.
 */
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
      publicKey: perplKey(publicKey),
      // The effective scope: trade implies read.
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

/**
 * Privy's form of Perpl's payload, as `toPrivyTypedData(toViemTypedData(t))`
 * writes it: numeric chain id and time, `primary_type`. The contract test
 * runs the real pair.
 */
function privyForm(t: PerplTypedData): Record<string, unknown> {
  return {
    domain: { ...t.domain, chainId: Number(BigInt(t.domain.chainId)) },
    types: t.types,
    primary_type: t.primaryType,
    message: { ...t.message, time: Number(BigInt(t.message['time']!)) },
  };
}

function enrollPayload(
  role: EnrollRole,
  typedData: unknown,
  key = enrollIdempotencyKey(PREPARE_ID, role),
): AuthorizationPayload {
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: { 'privy-app-id': 'app-id-test', 'privy-idempotency-key': key },
    body: { method: 'eth_signTypedData_v4', params: { typed_data: typedData } },
  };
}

type ItemTamper = {
  /** Rewrites Perpl's payload before both forms are built from it. */
  served?: (t: PerplTypedData) => PerplTypedData;
  /** Rewrites only Privy's form (what the wallet signs). */
  signed?: (privy: Record<string, unknown>) => Record<string, unknown>;
  key?: string;
};

function item(role: EnrollRole, tamper: ItemTamper = {}): EnrollPrepareItem {
  const base =
    role === 'trade'
      ? served('trade', TRADE_KEY, TRADE_LABEL)
      : served('read', READ_KEY, PERPL_READ_KEY_LABEL);
  const typedData = tamper.served ? tamper.served(base) : base;
  const signed = tamper.signed ? tamper.signed(privyForm(typedData)) : privyForm(typedData);
  return { role, payload: enrollPayload(role, signed, tamper.key), typedData };
}

function prepared(trade: ItemTamper = {}, read: ItemTamper = {}): EnrollPrepareResult {
  return {
    prepareId: PREPARE_ID,
    expiresAt: new Date(NOW + 300_000).toISOString(),
    items: [item('trade', trade), item('read', read)],
  };
}

const withMessage =
  (fields: Record<string, string>) =>
  (t: PerplTypedData): PerplTypedData => ({
    ...t,
    message: { ...t.message, ...fields },
  });

// ---------------------------------------------------------------------------
// Enrollment: what the server sends passes.

test('signs an honest enrollment and returns the trade key’s digest', () => {
  const result = verifyEnrollmentPrepare(prepared(), CTX);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match((result as { digest: string }).digest, /^0x[0-9a-f]{64}$/);
});

test('the digest is the one the venue computes for the proof of possession', async () => {
  const { toViemTypedData } = await import('@sente/venues/perpl');
  const { hashTypedData } = await import('viem');
  const result = verifyEnrollmentPrepare(prepared(), CTX);
  assert.ok(result.ok);
  const venue = hashTypedData(toViemTypedData(item('trade').typedData as never) as never);
  assert.equal(result.digest, venue);
});

test('accepts the live P5 trade payload, verbatim', () => {
  // `docs/user-trading.md` §P5: the trade-scope `/v1/api-key/payload` answer.
  const wallet = getAddress('0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF');
  const key: Hex = '0x2be8e424ff7f6ed41da4af772874a880db8a8f78636784806c3fd2ccd6d4b31c';
  const time = 0x1a121595e56;
  const live = (t: PerplTypedData): PerplTypedData => ({
    ...t,
    domain: {
      ...t.domain,
      salt: '0x00000000000000000000000000000000000000006ac90ca3895a93c38d4d3fb0',
    },
    message: {
      builderId: '0',
      expiresAt: '0',
      ipCidrs: '',
      label: 'sente-trade-live',
      maxBuilderFeePer100K: '0',
      origin: '',
      publicKey: 'K-jkJP9_btQdpK93KHSogNuKj3hjZ4SAbD_SzNbUsxw',
      scope: '3',
      signer: wallet,
      statement: PERPL_API_KEY_TYPED_DATA.statement,
      time: `0x${time.toString(16)}`,
    },
  });
  const trade = item('trade', { served: live });
  const verdict = verifyEnrollment(trade, {
    walletId: WALLET_ID,
    wallet,
    prepareId: PREPARE_ID,
    role: 'trade',
    label: 'sente-trade-live',
    publicKey: { equals: key },
    now: time,
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test('accepts a time at the edge of the skew window', () => {
  const edge = withMessage({ time: `0x${(NOW - PERPL_ENROLL_PINNED.timeSkewMs).toString(16)}` });
  assert.equal(verifyEnrollmentPrepare(prepared({ served: edge }), CTX).ok, true);
});

// ---------------------------------------------------------------------------
// Enrollment: one tamper per rule.

test('refuses drifted types: a field added', () => {
  const drift = (t: PerplTypedData): PerplTypedData => ({
    ...t,
    types: {
      ...t.types,
      PerplRegisterApiKey: [
        ...t.types['PerplRegisterApiKey']!,
        { name: 'withdraw', type: 'string' },
      ],
    },
    message: { ...t.message, withdraw: '' },
  });
  refused(verifyEnrollmentPrepare(prepared({ served: drift }), CTX), /struct is not the one/);
});

test('refuses drifted types: fields reordered, retyped, or an extra struct', () => {
  const swap = (t: PerplTypedData): PerplTypedData => {
    const fields = [...t.types['PerplRegisterApiKey']!];
    [fields[3], fields[4]] = [fields[4]!, fields[3]!];
    return { ...t, types: { ...t.types, PerplRegisterApiKey: fields } };
  };
  refused(verifyEnrollmentPrepare(prepared({ served: swap }), CTX), /struct is not the one/);
  const retype = (t: PerplTypedData): PerplTypedData => ({
    ...t,
    types: {
      ...t.types,
      PerplRegisterApiKey: t.types['PerplRegisterApiKey']!.map((f) =>
        f.name === 'time' ? { ...f, type: 'uint256' } : f,
      ),
    },
  });
  refused(verifyEnrollmentPrepare(prepared({ served: retype }), CTX), /struct is not the one/);
  const extra = (t: PerplTypedData): PerplTypedData => ({
    ...t,
    types: { ...t.types, Other: [{ name: 'x', type: 'string' }] },
  });
  refused(verifyEnrollmentPrepare(prepared({ served: extra }), CTX), /struct is not the one/);
});

test('refuses a builder fee', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ maxBuilderFeePer100K: '50' }) }), CTX),
    /builder charge a fee/,
  );
});

test('refuses a builder id', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ builderId: '7' }) }), CTX),
    /builder charge a fee/,
  );
});

test('refuses "not set" spelled any way but the one Perpl uses', () => {
  // The pre-P5 guesses: `''` for the numeric fields, `'0'` for the text ones.
  for (const [field, value] of [
    ['expiresAt', ''],
    ['builderId', ''],
    ['maxBuilderFeePer100K', ''],
    ['ipCidrs', '0'],
    ['origin', '0'],
  ] as const) {
    assert.equal(
      verifyEnrollmentPrepare(prepared({ served: withMessage({ [field]: value }) }), CTX).ok,
      false,
      `${field} '${value}'`,
    );
  }
});

test('refuses an expiry, an IP restriction or an origin nobody asked for', () => {
  for (const field of ['expiresAt', 'ipCidrs', 'origin']) {
    refused(
      verifyEnrollmentPrepare(prepared({ served: withMessage({ [field]: 'x' }) }), CTX),
      new RegExp(`its ${field} is x`),
    );
  }
});

test('refuses another signer', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ signer: STRANGER }) }), CTX),
    /not your wallet/,
  );
});

test('refuses a trade key that is not this phone’s', () => {
  refused(
    verifyEnrollmentPrepare(
      prepared({ served: withMessage({ publicKey: perplKey(READ_KEY) }) }),
      CTX,
    ),
    /not this phone’s/,
  );
});

test('refuses a read item that enrolls the phone’s own key', () => {
  refused(
    verifyEnrollmentPrepare(
      prepared({}, { served: withMessage({ publicKey: perplKey(TRADE_KEY) }) }),
      CTX,
    ),
    /this phone’s own key/,
  );
});

test('refuses a public key that is not 32 bytes, or not spelled as unpadded base64url', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ publicKey: '0x1234' }) }), CTX),
    /not a 32-byte key/,
  );
  // The same 32 bytes in every spelling Perpl did not use.
  const bytes = Buffer.from(TRADE_KEY.slice(2), 'hex');
  for (const other of [
    TRADE_KEY,
    TRADE_KEY.slice(2),
    bytes.toString('base64'),
    `${bytes.toString('base64url')}=`,
  ]) {
    if (other === perplKey(TRADE_KEY)) continue;
    refused(
      verifyEnrollmentPrepare(prepared({ served: withMessage({ publicKey: other }) }), CTX),
      /not a 32-byte key/,
    );
  }
  // Same 32 bytes, but the two spare bits set: a second spelling of one key.
  const b64 = perplKey(TRADE_KEY);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const dirty = b64.slice(0, 42) + last[last.indexOf(b64[42]!) | 1];
  if (dirty !== b64) {
    refused(
      verifyEnrollmentPrepare(prepared({ served: withMessage({ publicKey: dirty }) }), CTX),
      /not a 32-byte key/,
    );
  }
});

test('refuses the wrong scope on either item', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ scope: '2' }) }), CTX),
    /scope is 2, not trade/,
  );
  // The server's read key with trade scope would let the server trade.
  for (const scope of ['3', '2']) {
    refused(
      verifyEnrollmentPrepare(prepared({}, { served: withMessage({ scope }) }), CTX),
      new RegExp(`scope is ${scope}, not read`),
    );
  }
});

test('refuses a stale or future time', () => {
  const skew = PERPL_ENROLL_PINNED.timeSkewMs;
  refused(
    verifyEnrollmentPrepare(
      prepared({ served: withMessage({ time: `0x${(NOW - skew - 1).toString(16)}` }) }),
      CTX,
    ),
    /stale/,
  );
  refused(
    verifyEnrollmentPrepare(
      prepared({ served: withMessage({ time: `0x${(NOW + skew + 1).toString(16)}` }) }),
      CTX,
    ),
    /stale/,
  );
});

test('refuses another label', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ label: 'x' }) }), CTX),
    /label is x/,
  );
  refused(
    verifyEnrollmentPrepare(prepared({}, { served: withMessage({ label: 'x' }) }), CTX),
    /label is x/,
  );
});

test('refuses another statement', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ served: withMessage({ statement: 'I agree' }) }), CTX),
    /statement/,
  );
});

test('refuses another chain id, domain or verifying contract', () => {
  const domain = (fields: Partial<PerplTypedData['domain']>) => (t: PerplTypedData) => ({
    ...t,
    domain: { ...t.domain, ...fields },
  });
  refused(
    verifyEnrollmentPrepare(prepared({ served: domain({ chainId: '0x1' }) }), CTX),
    /chain 1/,
  );
  refused(
    verifyEnrollmentPrepare(prepared({ served: domain({ name: 'perpl.evil' }) }), CTX),
    /not Perpl's/,
  );
  refused(
    verifyEnrollmentPrepare(prepared({ served: domain({ verifyingContract: STRANGER }) }), CTX),
    /names contract/,
  );
});

test('refuses a signed form that differs from Perpl’s payload', () => {
  const later = (p: Record<string, unknown>) => ({
    ...p,
    message: { ...(p['message'] as object), time: NOW + 1 },
  });
  refused(
    verifyEnrollmentPrepare(prepared({ signed: later }), CTX),
    /not the one the wallet signs/,
  );
});

test('refuses extra keys anywhere in the signed typed data', () => {
  const extra = (p: Record<string, unknown>) => ({
    ...p,
    message: { ...(p['message'] as object), withdraw: '1' },
  });
  refused(verifyEnrollmentPrepare(prepared({ signed: extra }), CTX), /also carries withdraw/);
  const extraTop = (p: Record<string, unknown>) => ({ ...p, primaryType: 'x' });
  refused(verifyEnrollmentPrepare(prepared({ signed: extraTop }), CTX), /also carries primaryType/);
});

test('refuses another idempotency key, prepare id, item order or item count', () => {
  refused(
    verifyEnrollmentPrepare(prepared({ key: enrollIdempotencyKey(PREPARE_ID, 'read') }), CTX),
    /idempotency key/,
  );
  refused(verifyEnrollmentPrepare({ ...prepared(), prepareId: 'a:b' }, CTX), /not a UUID/);
  const p = prepared();
  refused(
    verifyEnrollmentPrepare({ ...p, items: [p.items[1]!, p.items[0]!] }, CTX),
    /item is for a read key/,
  );
  refused(
    verifyEnrollmentPrepare({ ...p, items: [p.items[0]!] }, CTX),
    /exactly a trade key and a read key/,
  );
});

test('refuses an item whose envelope is not a typed-data signature for this wallet', () => {
  const trade = item('trade');
  const elsewhere = {
    ...trade,
    payload: { ...trade.payload, url: 'https://api.privy.io/v1/wallets/other/rpc' },
  };
  refused(
    verifyEnrollment(elsewhere, {
      walletId: WALLET_ID,
      wallet: WALLET,
      prepareId: PREPARE_ID,
      role: 'trade',
      label: TRADE_LABEL,
      publicKey: { equals: TRADE_KEY },
      now: NOW,
    }),
    /not from your wallet/,
  );
});
