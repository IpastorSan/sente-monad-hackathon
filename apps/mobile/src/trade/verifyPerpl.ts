/**
 * Phone Perpl verifiers (SEN-98, plan M-T16): onboarding and API-key enrollment.
 *
 * The device key signs whatever it is handed (`auth/deviceKey.ts`), so these
 * are THE security boundary for the user's own Perpl account, exactly as
 * `verifyKuru.ts` is for Kuru. Everything is fail-closed: a shape this file
 * does not name is a refusal, never a pass-through.
 *
 * ONBOARDING (`verifyPerplOnboard`) checks the steps `perpl-planner.ts`
 * prepares, through the same envelope (`envelope.ts`) and call decoder
 * (`calls.ts`) as a Kuru trade:
 *
 *   [approve(Exchange, amount) on AUSD, createAccount(amount)]? → allowOrderForwarding(true)?
 *
 * in that order, at least one leg, `approve` and `createAccount` together or
 * not at all (a resumed onboarding is the forwarding leg alone). `amount` is
 * the one the user confirmed, never below Perpl's opening minimum, and the
 * approval is exactly it, so nothing stays approved once the account opens.
 *
 * ENROLLMENT (`verifyEnrollmentPrepare`, per item `verifyEnrollment`) checks
 * what `perpl-enroll.service.ts` prepares: two Privy `eth_signTypedData_v4`
 * requests, each making the user's wallet sign Perpl's `PerplRegisterApiKey`.
 * A signature there registers an API key on the user's Perpl account, so the
 * typed data is held to {@link PERPL_ENROLL_PINNED} field by field: who signs
 * (the wallet), which key (the trade item: this phone's own derived key),
 * which scope (trade for the phone, read for the server), no builder and no
 * builder fee (a builder fee would skim every order placed with the key), a
 * fresh `time`, Perpl's own domain. Perpl's verbatim payload, whose digest
 * the trade key's proof of possession signs, must hash to the same digest as
 * the request the wallet signs.
 *
 * See docs/design/trading/plan-trading.md, Architecture §3, and CLAUDE.md
 * gotcha 13 for why the struct is pinned exactly.
 *
 * Pure TS: `verifyPerpl.test.ts` runs under plain node.
 */
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import {
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  isAddress,
  isAddressEqual,
  isHex,
  size,
  sliceHex,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import { isSameCallData, type Erc7579Call } from '../wallet/batch.ts';
import { decodeTransactionCalls } from './calls.ts';
import { tradeIdempotencyKey, verifyTradeEnvelope } from './envelope.ts';
import type {
  EnrollPrepareItem,
  EnrollPrepareResult,
  EnrollRole,
  PerplOnboardIntent,
  PreparedStep,
  StepKind,
} from './types.ts';

// ---------------------------------------------------------------------------
// The pinned enrollment format.

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * Everything the phone accepts in an enrollment payload, in ONE place.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PENDING PROBE P5. Mirrors `PERPL_ENROLL_FIELDS` and `ENROLL_TIME_SKEW_MS`
 * in `services/api/src/trade/perpl-enroll-format.ts` and the struct in
 * `PERPL_API_KEY_TYPED_DATA` (`@sente/venues/perpl`), which are the best
 * reading of the 2026-09-10/11 observations. When P5 records Perpl's live
 * payloads, the server pins them there and THIS constant follows in the same
 * change: `contract.test.ts` fails until the two agree. Narrow, never widen:
 * every spelling accepted here is one a compromised server may choose.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Mirrored rather than imported so that what the phone signs changes only
 * with an app release, and so a drift on either side shows up as a failing
 * test rather than a silent widening.
 */
export const PERPL_ENROLL_PINNED = {
  domain: {
    name: 'perpl.xyz',
    version: '1',
    chainId: 10143,
    /** Perpl's domain names no contract. `salt` drifts daily and is not pinned. */
    verifyingContract: ZERO_ADDRESS,
  },
  primaryType: 'PerplRegisterApiKey',
  /** Exactly these, in this order, nothing else (gotcha 13). */
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
    ],
    PerplRegisterApiKey: [
      { name: 'signer', type: 'address' },
      { name: 'statement', type: 'string' },
      { name: 'publicKey', type: 'string' },
      { name: 'scope', type: 'string' },
      { name: 'label', type: 'string' },
      { name: 'expiresAt', type: 'string' },
      { name: 'ipCidrs', type: 'string' },
      { name: 'origin', type: 'string' },
      { name: 'builderId', type: 'string' },
      { name: 'maxBuilderFeePer100K', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  statement: 'I authorize the creation of Perpl API key with the specified scope and parameters',
  /** The message's `scope` per role: the `scope_mask` as a decimal string (read 1, trade 2). */
  scope: { trade: '2', read: '1' } satisfies Record<EnrollRole, string>,
  /**
   * Fields we never ask Perpl to fill, and the spellings of "not set" each
   * accepts. `builderId` and `maxBuilderFeePer100K` are the builder fee: any
   * other value lets a third party skim every order placed with the key.
   */
  empty: {
    expiresAt: ['', '0'],
    ipCidrs: [''],
    origin: [''],
    builderId: [''],
    maxBuilderFeePer100K: ['', '0'],
  } satisfies Record<string, readonly string[]>,
  /** How the message's `publicKey` may spell the 32 key bytes. */
  publicKeyEncodings: ['hex', 'base64'] as readonly ('hex' | 'base64')[],
  /** `time` is Unix milliseconds and may sit this far from the phone's clock. */
  timeSkewMs: 5 * 60 * 1000,
} as const;

/** The label the server's read key is enrolled under (`READ_KEY_LABEL` on the server). */
export const PERPL_READ_KEY_LABEL = 'sente-portfolio-read';

/**
 * Perpl's opening minimum, 100 AUSD (6 decimals). The server reads it live
 * from Perpl's context; the phone holds its own so a server cannot talk it
 * into an account Perpl would refuse to open (or below what it showed).
 */
export const PERPL_MIN_ACCOUNT_OPEN_ATOMS = 100_000_000n;

/**
 * The `privy-idempotency-key` of one enrollment request. Must equal the
 * server's `enrollIdempotencyKey` byte for byte (`contract.test.ts` pins it).
 */
export function enrollIdempotencyKey(prepareId: string, role: EnrollRole): string {
  return `sente-enroll:${prepareId}:${role}`;
}

// ---------------------------------------------------------------------------
// Shared.

export type PerplVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string; readonly stepIndex?: number };

type Refusal = { readonly ok: false; readonly problem: string; readonly stepIndex?: number };

const refuse = (problem: string, stepIndex?: number): Refusal =>
  stepIndex === undefined ? { ok: false, problem } : { ok: false, problem, stepIndex };

const PASS: PerplVerifyResult = { ok: true };

/** Lowercase or uppercase hex, v4 version nibble, RFC 4122 variant. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Canonical non-negative decimal: no sign, no leading zeros, no exponent. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const EXCHANGE = PERPL_TESTNET_CONTRACTS.exchange;
const AUSD = PERPL_TESTNET_CONTRACTS.collateral;

// ---------------------------------------------------------------------------
// Onboarding.

export type PerplOnboardVerifyContext = {
  /** Privy's id for the user's wallet; pins every envelope's URL. */
  readonly walletId: string;
  /** The same wallet's address; the only account a self-call may be. */
  readonly wallet: Address;
  /** What the user confirmed on this phone. */
  readonly intent: PerplOnboardIntent;
};

const APPROVE = {
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
} as const satisfies AbiFunction;

const CREATE_ACCOUNT = {
  type: 'function',
  name: 'createAccount',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'amountCNS', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction;

const ALLOW_ORDER_FORWARDING = {
  type: 'function',
  name: 'allowOrderForwarding',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'allow', type: 'bool' }],
  outputs: [],
} as const satisfies AbiFunction;

/**
 * The whole onboarding allow-list. Hand-written, like `KURU_LEG_ABI`, so the
 * Exchange's `depositCollateral`, `withdrawCollateral` and the rest never
 * decode; exported only so the test can pin each selector to the venue ABI.
 */
export const PERPL_ONBOARD_ABI = [APPROVE, CREATE_ACCOUNT, ALLOW_ORDER_FORWARDING] as const;

type OnboardLeg =
  | { readonly kind: 'perpl.approve'; readonly amount: bigint; readonly stepIndex: number }
  | { readonly kind: 'perpl.createAccount'; readonly amount: bigint; readonly stepIndex: number }
  | { readonly kind: 'perpl.allowForwarding'; readonly stepIndex: number };

const FRAGMENT_BY_SELECTOR: ReadonlyMap<Hex, AbiFunction> = new Map(
  PERPL_ONBOARD_ABI.map((fragment) => [toFunctionSelector(fragment), fragment]),
);

/**
 * Checks every step of a prepared Perpl onboarding against the amount the
 * user confirmed. `{ok: true}` means the phone may sign ALL of `steps`; any
 * refusal means it signs none of them.
 */
export function verifyPerplOnboard(
  steps: readonly PreparedStep[],
  ctx: PerplOnboardVerifyContext,
): PerplVerifyResult {
  const { intent } = ctx;
  if (intent.kind !== 'perpl.onboard') return refuse('the trade is not a Perpl onboarding');
  // Seeds the idempotency keys: a UUID cannot contain ':', so no key can be
  // forged across the separator.
  if (typeof intent.clientTradeId !== 'string' || !UUID_V4.test(intent.clientTradeId)) {
    return refuse('the trade id is not a phone-generated UUID');
  }
  const amount = parseAtoms(intent.amountAtoms);
  if (amount === undefined) return refuse('the deposit is not an amount');
  if (amount < PERPL_MIN_ACCOUNT_OPEN_ATOMS) {
    return refuse('the deposit is below the 100 AUSD Perpl needs to open an account');
  }
  if (steps.length === 0) return refuse('the onboarding has no steps');

  const legs: OnboardLeg[] = [];
  for (const [position, step] of steps.entries()) {
    if (step.index !== position) {
      return refuse(`step ${position} claims to be step ${String(step.index)}`, position);
    }
    const stepLegs = decodeOnboardStep(step, ctx);
    if (!stepLegs.ok) return stepLegs;
    legs.push(...stepLegs.legs);
  }

  // Walk the one allowed shape; anything left over or out of place is refused.
  let i = 0;
  const approve = legs[i]?.kind === 'perpl.approve' ? legs[i++] : undefined;
  const create = legs[i]?.kind === 'perpl.createAccount' ? legs[i++] : undefined;
  const forward = legs[i]?.kind === 'perpl.allowForwarding' ? legs[i++] : undefined;
  if (i !== legs.length) {
    return refuse(`a ${legs[i]!.kind} leg is out of place`, legs[i]!.stepIndex);
  }
  if (approve === undefined && create === undefined && forward === undefined) {
    return refuse('the onboarding does nothing');
  }
  if (approve !== undefined && create === undefined) {
    // An approval nothing consumes is a standing allowance for nothing.
    return refuse('the approval is not followed by opening the account', approve.stepIndex);
  }
  if (create !== undefined && approve === undefined) {
    return refuse('the account is opened without approving its deposit', create.stepIndex);
  }
  if (approve?.kind === 'perpl.approve' && create?.kind === 'perpl.createAccount') {
    if (create.amount !== amount) {
      return refuse('the account opens with another amount than you confirmed', create.stepIndex);
    }
    if (approve.amount !== create.amount) {
      return refuse('the approval is not exactly the deposit', approve.stepIndex);
    }
  }
  return PASS;
}

/** Envelope → calls → legs for one step, plus the step's own label. */
function decodeOnboardStep(
  step: PreparedStep,
  ctx: PerplOnboardVerifyContext,
): { readonly ok: true; readonly legs: OnboardLeg[] } | Refusal {
  const at = step.index;
  const envelope = verifyTradeEnvelope(step.payload, {
    walletId: ctx.walletId,
    idempotencyKey: tradeIdempotencyKey(ctx.intent.clientTradeId, at),
    rpcMethod: 'eth_sendTransaction',
  });
  if (!envelope.ok) return refuse(envelope.problem, at);

  const decoded = decodeTransactionCalls(envelope.params['transaction'], ctx.wallet);
  if (!decoded.ok) return refuse(decoded.problem, at);

  const legs: OnboardLeg[] = [];
  for (const call of decoded.calls) {
    const leg = classifyOnboardCall(call, at);
    if (!leg.ok) return refuse(leg.problem, at);
    legs.push(leg.leg);
  }

  // The label is what the progress UI shows; it must say what the step does.
  const expectedKind: StepKind | undefined = decoded.batched ? 'batch' : legs[0]?.kind;
  if (step.kind !== expectedKind) {
    return refuse(`the step is labelled ${step.kind} but it is ${String(expectedKind)}`, at);
  }
  return { ok: true, legs };
}

/** One call → one onboarding leg, with its context-free hazards refused. */
function classifyOnboardCall(
  call: Erc7579Call,
  stepIndex: number,
): { readonly ok: true; readonly leg: OnboardLeg } | Refusal {
  const data = call.data ?? '0x';
  if (size(data) < 4) return refuse('the call has no function selector');
  const fragment = FRAGMENT_BY_SELECTOR.get(sliceHex(data, 0, 4).toLowerCase() as Hex);
  if (fragment === undefined) {
    return refuse(`function ${sliceHex(data, 0, 4)} is not a Perpl onboarding call`);
  }
  const args = decodeCanonical(fragment, data);
  if (!Array.isArray(args)) return args as Refusal;
  // Onboarding moves AUSD by allowance; MON leaving with any leg is for nothing.
  if ((call.value ?? 0n) !== 0n) return refuse(`the ${fragment.name} call carries value`);

  if (fragment === APPROVE) {
    const [spender, amount] = args as [Address, bigint];
    if (!isAddressEqual(call.to, AUSD)) return refuse(`the approval is on ${call.to}, not AUSD`);
    if (!isAddressEqual(spender, EXCHANGE)) {
      return refuse(`the approval lets ${spender} spend your AUSD, not the Perpl Exchange`);
    }
    return { ok: true, leg: { kind: 'perpl.approve', amount, stepIndex } };
  }
  // Both Exchange calls act on the account of whoever sends them, so the
  // Exchange is the only target that makes them mean what the user saw.
  if (!isAddressEqual(call.to, EXCHANGE)) {
    return refuse(`the ${fragment.name} call goes to ${call.to}, not the Perpl Exchange`);
  }
  if (fragment === CREATE_ACCOUNT) {
    const [amount] = args as [bigint];
    return { ok: true, leg: { kind: 'perpl.createAccount', amount, stepIndex } };
  }
  const [allow] = args as [boolean];
  if (allow !== true) return refuse('the step turns order forwarding off');
  return { ok: true, leg: { kind: 'perpl.allowForwarding', stepIndex } };
}

/** Decodes against exactly one fragment and re-encodes: the signature covers bytes. */
function decodeCanonical(fragment: AbiFunction, data: Hex): readonly unknown[] | Refusal {
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: [fragment] as readonly AbiFunction[], data }).args ?? [];
  } catch {
    return refuse(`the ${fragment.name} call does not decode`);
  }
  let reencoded: Hex;
  try {
    reencoded = encodeFunctionData({
      abi: [fragment] as readonly AbiFunction[],
      functionName: fragment.name,
      args,
    });
  } catch {
    return refuse(`the ${fragment.name} call does not re-encode`);
  }
  if (!isSameCallData(reencoded, data)) {
    return refuse(`the ${fragment.name} call is not canonically encoded`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Enrollment.

export type EnrollVerifyContext = {
  /** Privy's id for the user's wallet; pins every envelope's URL. */
  readonly walletId: string;
  /** The wallet that owns the Perpl account: the only signer accepted. */
  readonly wallet: Address;
  /** `perplTradeKey(deviceKey, wallet).publicKeyHex`: the only key the trade item may enroll. */
  readonly tradePublicKeyHex: Hex;
  /** The label this phone asked the trade key to be enrolled under. */
  readonly tradeLabel: string;
  /** The phone's clock, Unix ms. */
  readonly now: number;
};

/** One item's expectation; {@link verifyEnrollmentPrepare} derives both from the context. */
export type EnrollItemExpectation = {
  readonly walletId: string;
  readonly wallet: Address;
  readonly prepareId: string;
  readonly role: EnrollRole;
  readonly label: string;
  /**
   * `equals`: the key must be exactly this one (the phone's trade key).
   * `differsFrom`: any 32-byte key but this one (the server's read key, which
   * the phone never sees the secret of and must not be the phone's own).
   */
  readonly publicKey: { readonly equals: Hex } | { readonly differsFrom: Hex };
  readonly now: number;
};

export type EnrollVerifyResult =
  | {
      readonly ok: true;
      /** The EIP-712 digest, computed here: what the key's proof of possession signs. */
      readonly digest: Hex;
    }
  | { readonly ok: false; readonly problem: string; readonly role?: EnrollRole };

type EnrollRefusal = { readonly ok: false; readonly problem: string; readonly role?: EnrollRole };

const ROLES: readonly EnrollRole[] = ['trade', 'read'];

/**
 * Checks a whole enrollment prepare: exactly a trade item then a read item,
 * each enrolling the right key with the right scope for the user's wallet.
 * `{ok: true}` means the phone may sign BOTH payloads, and `digest` is the
 * trade item's, for the proof of possession; any refusal means neither.
 */
export function verifyEnrollmentPrepare(
  prepared: EnrollPrepareResult,
  ctx: EnrollVerifyContext,
): EnrollVerifyResult {
  if (!isRecord(prepared)) return refuseEnroll('the enrollment is not an object');
  // Seeds both idempotency keys; a UUID cannot contain ':'.
  if (typeof prepared.prepareId !== 'string' || !UUID_V4.test(prepared.prepareId)) {
    return refuseEnroll('the enrollment id is not a UUID');
  }
  const items = prepared.items;
  if (!Array.isArray(items) || items.length !== ROLES.length) {
    return refuseEnroll('the enrollment is not exactly a trade key and a read key');
  }
  let tradeDigest: Hex | undefined;
  for (const [i, role] of ROLES.entries()) {
    const verdict = verifyEnrollment(items[i] as EnrollPrepareItem, {
      walletId: ctx.walletId,
      wallet: ctx.wallet,
      prepareId: prepared.prepareId,
      role,
      label: role === 'trade' ? ctx.tradeLabel : PERPL_READ_KEY_LABEL,
      publicKey:
        role === 'trade'
          ? { equals: ctx.tradePublicKeyHex }
          : { differsFrom: ctx.tradePublicKeyHex },
      now: ctx.now,
    });
    if (!verdict.ok) return verdict;
    if (role === 'trade') tradeDigest = verdict.digest;
  }
  return { ok: true, digest: tradeDigest! };
}

/** Checks one enrollment item against what this phone expects of it. */
export function verifyEnrollment(
  item: EnrollPrepareItem,
  expected: EnrollItemExpectation,
): EnrollVerifyResult {
  const { role } = expected;
  const no = (problem: string) => refuseEnroll(`the ${role} key: ${problem}`, role);
  if (!isRecord(item)) return no('the item is not an object');
  if (item.role !== role) return no(`the item is for a ${String(item.role)} key`);
  if (typeof expected.prepareId !== 'string' || !UUID_V4.test(expected.prepareId)) {
    return no('the enrollment id is not a UUID');
  }

  const envelope = verifyTradeEnvelope(item.payload, {
    walletId: expected.walletId,
    idempotencyKey: enrollIdempotencyKey(expected.prepareId, role),
    rpcMethod: 'eth_signTypedData_v4',
  });
  if (!envelope.ok) return no(envelope.problem);

  // What the wallet signs: Privy's form of the typed data.
  const signed = readPrivyTypedData(envelope.params['typed_data']);
  if (!signed.ok) return no(signed.problem);
  const problem = messageProblem(signed.typed, expected);
  if (problem) return no(problem);

  // What the proof of possession signs: Perpl's verbatim form, which must be
  // the very same struct, or the key would vouch for something unchecked.
  const verbatim = readPerplTypedData(item.typedData);
  if (!verbatim.ok) return no(verbatim.problem);
  let digest: Hex;
  let verbatimDigest: Hex;
  try {
    digest = hashTypedData(signed.typed);
    verbatimDigest = hashTypedData(verbatim.typed);
  } catch {
    return no('the typed data does not hash');
  }
  if (digest !== verbatimDigest) return no("Perpl's payload is not the one the wallet signs");
  return { ok: true, digest };
}

const refuseEnroll = (problem: string, role?: EnrollRole): EnrollRefusal =>
  role === undefined ? { ok: false, problem } : { ok: false, problem, role };

/** The typed data in the shape viem hashes: numeric chain id, bigint `time`. */
type Eip712 = {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: Address;
    readonly salt: Hex;
  };
  readonly types: { readonly PerplRegisterApiKey: readonly { name: string; type: string }[] };
  readonly primaryType: 'PerplRegisterApiKey';
  readonly message: Record<string, string | bigint>;
};

type Read = { readonly ok: true; readonly typed: Eip712 } | { readonly ok: false; problem: string };

const STRUCT = PERPL_ENROLL_PINNED.types.PerplRegisterApiKey;

/**
 * Privy's form, exactly as `toPrivyTypedData` writes it: `primary_type`,
 * `chainId` and `time` as JSON numbers, every other field a string.
 */
function readPrivyTypedData(value: unknown): Read {
  if (!isRecord(value)) return { ok: false, problem: 'the typed data is not an object' };
  const keys = exactKeys(value, ['domain', 'types', 'primary_type', 'message'], 'the typed data');
  if (keys) return { ok: false, problem: keys };
  return readTyped(value['domain'], value['types'], value['primary_type'], value['message'], {
    uint: (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null),
  });
}

/** Perpl's form: `primaryType`, and `chainId` and `time` as integer strings. */
function readPerplTypedData(value: unknown): Read {
  if (!isRecord(value)) return { ok: false, problem: "Perpl's typed data is not an object" };
  const keys = exactKeys(value, ['types', 'primaryType', 'domain', 'message'], "Perpl's payload");
  if (keys) return { ok: false, problem: keys };
  return readTyped(value['domain'], value['types'], value['primaryType'], value['message'], {
    uint: (v) =>
      typeof v === 'string' && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v) ? BigInt(v) : null,
  });
}

/** Shape and pinned constants common to both forms; message values are judged later. */
function readTyped(
  domain: unknown,
  types: unknown,
  primaryType: unknown,
  message: unknown,
  parse: { uint: (value: unknown) => bigint | null },
): Read {
  const fail = (problem: string): Read => ({ ok: false, problem });
  const pinned = PERPL_ENROLL_PINNED;

  if (!isRecord(domain)) return fail('the domain is not an object');
  const domainKeys = exactKeys(
    domain,
    pinned.types.EIP712Domain.map((f) => f.name),
    'the domain',
  );
  if (domainKeys) return fail(domainKeys);
  if (domain['name'] !== pinned.domain.name || domain['version'] !== pinned.domain.version) {
    return fail(
      `the domain is ${String(domain['name'])} v${String(domain['version'])}, not Perpl's`,
    );
  }
  const chainId = parse.uint(domain['chainId']);
  if (chainId !== BigInt(pinned.domain.chainId)) {
    return fail(`the domain is for chain ${String(domain['chainId'])}, not Monad testnet`);
  }
  const verifyingContract = domain['verifyingContract'];
  if (
    typeof verifyingContract !== 'string' ||
    !isAddress(verifyingContract, { strict: false }) ||
    !isAddressEqual(verifyingContract, pinned.domain.verifyingContract)
  ) {
    return fail(`the domain names contract ${String(verifyingContract)}`);
  }
  const salt = domain['salt'];
  if (typeof salt !== 'string' || !isHex(salt, { strict: true }) || salt.length !== 66) {
    return fail('the domain salt is not 32 bytes');
  }

  if (primaryType !== pinned.primaryType) return fail(`it signs a ${String(primaryType)}`);
  if (!sameTypes(types)) return fail('the typed-data struct is not the one this app knows');

  if (!isRecord(message)) return fail('the message is not an object');
  const messageKeys = exactKeys(
    message,
    STRUCT.map((f) => f.name),
    'the message',
  );
  if (messageKeys) return fail(messageKeys);
  const values: Record<string, string | bigint> = {};
  for (const field of STRUCT) {
    const raw = message[field.name];
    if (field.type === 'uint64') {
      const n = parse.uint(raw);
      if (n === null || n >= 2n ** 64n) return fail(`the message's ${field.name} is not a uint64`);
      values[field.name] = n;
    } else if (typeof raw === 'string') {
      values[field.name] = raw;
    } else {
      return fail(`the message's ${field.name} is not a string`);
    }
  }
  return {
    ok: true,
    typed: {
      domain: {
        name: pinned.domain.name,
        version: pinned.domain.version,
        chainId: pinned.domain.chainId,
        verifyingContract: verifyingContract as Address,
        salt: salt as Hex,
      },
      types: { PerplRegisterApiKey: STRUCT.map((f) => ({ ...f })) },
      primaryType: pinned.primaryType,
      message: values,
    },
  };
}

/** `types` exactly the pinned ones: same structs, same fields, same order, nothing else. */
function sameTypes(types: unknown): boolean {
  if (!isRecord(types)) return false;
  const want: Record<string, readonly { name: string; type: string }[]> = PERPL_ENROLL_PINNED.types;
  const names = Object.keys(types);
  if (names.length !== Object.keys(want).length) return false;
  return names.every((name) => {
    const expected = want[name];
    const got = types[name];
    return (
      expected !== undefined &&
      Array.isArray(got) &&
      got.length === expected.length &&
      got.every(
        (field: unknown, i) =>
          isRecord(field) &&
          Object.keys(field).length === 2 &&
          field['name'] === expected[i]!.name &&
          field['type'] === expected[i]!.type,
      )
    );
  });
}

/** Every message field is judged here, explicitly or as one that must be empty. */
function messageProblem(typed: Eip712, expected: EnrollItemExpectation): string | undefined {
  const pinned = PERPL_ENROLL_PINNED;
  const m = typed.message;
  const signer = m['signer'] as string;
  if (!isAddress(signer, { strict: false }) || !isAddressEqual(signer, expected.wallet)) {
    return `it would be signed for ${signer}, not your wallet`;
  }
  if (m['statement'] !== pinned.statement) return 'its statement is not Perpl’s API-key statement';

  const key = publicKeyBytes(m['publicKey'] as string);
  if (key === undefined) return `its public key ${String(m['publicKey'])} is not a 32-byte key`;
  if ('equals' in expected.publicKey) {
    if (key !== expected.publicKey.equals.toLowerCase()) {
      return 'it enrolls a key that is not this phone’s';
    }
  } else if (key === expected.publicKey.differsFrom.toLowerCase()) {
    return 'it enrolls this phone’s own key';
  }

  if (m['scope'] !== pinned.scope[expected.role]) {
    return `its scope is ${String(m['scope'])}, not ${expected.role}`;
  }
  if (m['label'] !== expected.label) return `its label is ${String(m['label'])}`;

  for (const [name, allowed] of Object.entries(pinned.empty)) {
    if (!(allowed as readonly string[]).includes(m[name] as string)) {
      return name === 'builderId' || name === 'maxBuilderFeePer100K'
        ? `it lets a builder charge a fee on every order (${name} ${String(m[name])})`
        : `its ${name} is ${String(m[name])}, which this app never asks for`;
    }
  }

  const time = m['time'] as bigint;
  const skew = BigInt(pinned.timeSkewMs);
  const now = BigInt(Math.trunc(expected.now));
  if (time < now - skew || time > now + skew) return 'it is stale: its time is not now';

  // Fail closed on a field the checks above never named: a new pinned field
  // must come with a rule before anything carrying it is signed.
  const judged = new Set(['signer', 'statement', 'publicKey', 'scope', 'label', 'time']);
  const unjudged = STRUCT.find((f) => !judged.has(f.name) && !Object.hasOwn(pinned.empty, f.name));
  if (unjudged) return `its ${unjudged.name} has no rule in this app`;
  return undefined;
}

/**
 * The message's `publicKey` as lowercase `0x` hex, if it spells 32 bytes in an
 * encoding {@link PERPL_ENROLL_PINNED} accepts.
 */
function publicKeyBytes(field: string): Hex | undefined {
  const encodings = PERPL_ENROLL_PINNED.publicKeyEncodings;
  if (encodings.includes('hex')) {
    const hex = field.startsWith('0x') ? field : `0x${field}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(hex)) return hex.toLowerCase() as Hex;
  }
  if (encodings.includes('base64') && /^[A-Za-z0-9+/_-]{43}=?$/.test(field)) {
    return base64ToHex(field);
  }
  return undefined;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 or base64url (43 chars, optional pad) → 32 bytes as hex. No `Buffer` on Hermes. */
function base64ToHex(field: string): Hex | undefined {
  const text = field.replace(/=$/, '').replace(/-/g, '+').replace(/_/g, '/');
  let bits = 0;
  let acc = 0;
  let hex = '0x';
  for (const char of text) {
    acc = (acc << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  // 43 chars carry 258 bits: 32 bytes and 2 leftover bits, which must be zero
  // or two spellings would name one key.
  if ((acc & ((1 << bits) - 1)) !== 0 || hex.length !== 66) return undefined;
  return hex as Hex;
}

// ---------------------------------------------------------------------------

/** Exactly `keys`, all present, nothing else — or a sentence saying what differs. */
function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): string | undefined {
  const actual = Object.keys(record);
  const extra = actual.filter((key) => !keys.includes(key));
  if (extra.length > 0) return `${what} also carries ${extra.join(', ')}`;
  const missing = keys.filter((key) => !actual.includes(key));
  if (missing.length > 0) return `${what} is missing ${missing.join(', ')}`;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A wire amount, strictly: `"010"`, `"1e3"` or `" 1"` is not one. */
function parseAtoms(value: unknown): bigint | undefined {
  return typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : undefined;
}
