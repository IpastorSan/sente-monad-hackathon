/**
 * Approving a mandate change with the device key (SEN-44) — and, before that,
 * reading the change.
 *
 * The API cannot change a device-owned agent's mandate: the Privy policy is
 * owned by the key quorum holding this phone's key, so only a request this
 * phone signed is accepted (SEN-43). The flow is therefore prepare → verify →
 * sign → commit, and **the verify step is the whole point**.
 *
 * `signPrivyAuthorization` is a blind signer: it signs the bytes it is handed.
 * Signing a payload the server composed would make this key a rubber stamp —
 * the server could hand over a PATCH that widens the agent instead of the one
 * the user typed, and the enclave would accept it, because the enclave checks
 * the signature, not our intent. So the phone rebuilds what the change must
 * look like from the mandate IT is sending, and refuses to sign anything else.
 *
 * ## What is checked, exactly
 *
 * Against `payload`, which is what the signature covers:
 *
 * 1. `version` is 1 and `method` is `PATCH` — nothing else is ever signed here.
 * 2. `url` is `https://api.privy.io/v1/policies/<this agent's policyId>`,
 *    character for character. A different policy id would change someone
 *    else's agent; a different host would be a different API.
 * 3. `headers` is an object carrying only `privy-app-id` (and, if present, an
 *    idempotency key), because the headers are signed too — and the app id is
 *    a non-empty string, not merely something truthy (SEN-142).
 * 4. `body` has exactly one key, `rules`.
 * 5. For a revoke, `rules` is exactly the mandate's RECOVERY rules and nothing
 *    else (SEN-17): the Kuru withdraw, which pays the agent's own wallet, and one
 *    ERC-20 transfer per token pinned to `returnTo`, which is the owner's wallet.
 *    A revoke used to be checked as `rules: []`, and the policy it leaves is no
 *    longer empty — because an empty policy also strands whatever the agent is
 *    holding. What must still be true is that nothing which lets the agent TAKE
 *    risk survives, and rule-set equality against the mirrored compiler says
 *    exactly that: an approve, a deposit, a trade or an enrollment rule in that
 *    payload is one rule too many, and this refuses to sign it.
 * 6. For an amend, the rules are EXACTLY the rules the mandate compiles to:
 *    same set of rules, each with the same method and the same set of
 *    conditions, compared as `field_source|field|operator|value`. Not a subset,
 *    not "nothing worse than" — equal. One extra rule is one extra thing the
 *    agent could sign.
 * 7. `returnTo` is THIS PHONE'S wallet (SEN-124). Before anything else, the
 *    mandate's `returnTo` must equal `intent.ownWallet` — the user's Privy
 *    wallet as the session registered it with this phone's device key — and the
 *    transfer rules are then built from that address, never from the mandate's
 *    copy. See {@link pinReturnTo}.
 * 8. Every condition's `abi` or `typed_data` blob is the canonical one (SEN-142):
 *    its keccak256, over the RFC 8785 form, equals the hash pinned in
 *    {@link BLOB} for that condition, and a condition that names none carries
 *    none. See {@link BLOB} for why.
 *
 * ## Why the expected rules are mirrored rather than imported
 *
 * `compileMandate` lives in `@sente/mandate`, which the app does not import at
 * runtime (CLAUDE.md gotchas 2 and 10). {@link expectedPolicyRules} is the
 * mirror, and `approval.test.ts` pins it equal to `compileMandate` over a
 * fixture set with the real package, exactly as `deviceKey.ts` pins its
 * canonicalizer. If that test fails, the two have drifted and this file would
 * refuse mandate changes the API composed correctly.
 *
 * `mandate.returnTo` is part of that mirror (SEN-17). The app does not let a
 * user type it — the API resolves the owner's own wallet and refuses a mandate
 * naming anything else — but the app must still SEND it and EXPECT its rules,
 * because they are rules the compiled policy carries. Before SEN-17 it did
 * neither, and a mandate with an exit could not be amended from the phone at all:
 * the check refused the extra rules. That was the right way round to be wrong,
 * and it is the reason this file changed in the same commit as the API.
 *
 * Plain TS, no React Native: `approval.test.ts` runs under plain node.
 */
import { KURU_TESTNET_CONTRACTS, KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { getAddress, isAddressEqual, keccak256, stringToBytes, type Address } from 'viem';

import { canonicalize, type AuthorizationPayload } from '../auth/deviceKey.ts';
import {
  ALLOWED_HEADERS,
  NoDeviceKeyError,
  PRIVY_API_BASE,
  refuse,
  type Approver,
  type VerifyResult,
} from '../auth/privyApproval.ts';
import {
  describeAgentsError,
  type Agent,
  type AgentMandate,
  type AgentsApi,
  type PreparedMandateChange,
} from './api.ts';
import {
  AUSD,
  PERPL_ENROLL_STATEMENT,
  PERPL_ENROLL_VERIFYING_CONTRACT,
  PERPL_EXCHANGE,
} from './mandate.ts';

/**
 * The addresses a compiled policy names, checksummed once at module load.
 *
 * `getAddress` is a keccak256 per call, and this runs between the user's tap
 * and the biometric prompt — hashing four constants on every verification is
 * work that has one possible answer.
 */
const ACCOUNT_CORE = getAddress(KURU_TESTNET_CONTRACTS.accountCore);
const EXCHANGE = getAddress(PERPL_EXCHANGE);
const COLLATERAL = getAddress(AUSD.address);
const ENROLL_VERIFYING_CONTRACT = getAddress(PERPL_ENROLL_VERIFYING_CONTRACT);

/**
 * Every ERC-20 a compiled mandate has a return rule for, in the compiler's own
 * order: Kuru's tokens except native MON, then Perpl's AUSD (`returnableTokens`
 * in `@sente/mandate`). Order does not matter to the comparison, which is a
 * multiset, but keeping it makes the two readable side by side.
 */
const RETURNABLE = [
  ...Object.values(KURU_TESTNET_TOKENS)
    .filter((token) => !isAddressEqual(token.address, NATIVE_TOKEN))
    .map((token) => getAddress(token.address)),
  getAddress(AUSD.address),
];

/**
 * The decoding blobs a compiled policy carries, pinned by hash (SEN-142).
 *
 * A calldata condition is only as good as the ABI Privy decodes it with. The
 * phone used to compare `function_name eq withdraw` and ignore the `abi` beside
 * it — but the server writes that ABI, and one naming `withdraw` over the
 * 4-byte selector of `transferBetweenAccounts` (or any other function) would
 * make the same condition match a call the user never allowed. Likewise a
 * `typed_data` descriptor decides which struct `statement` is read out of. So
 * each blob is checked, not trusted: keccak256 of its canonical JSON must be
 * exactly the one this table names for that condition.
 *
 * Literal hashes rather than the ABIs themselves, because `PERPL_ENROLL_TYPED_DATA`
 * lives in `@sente/mandate`, which the app does not import at runtime (gotchas
 * 2 and 10), and a hash is the one form that cannot be half-mirrored.
 * `approval.test.ts` pins every entry to the real constants through the
 * compiler; when one changes — Perpl's enrollment struct drifts (gotcha 13) —
 * that test fails and the hash here must change in the same commit. Until the
 * app ships it, an old build refuses the new shape: fail closed, by design.
 */
const BLOB = {
  erc20Approve: 'abi:0x490c886ad5215051b719391097d15dd8f2fdfe72ded3158a8de693237aea96bc',
  erc20Transfer: 'abi:0x59cc12fde94ff40f94cd755f0c06e5724ec762b3ae71e9f62f0c370b60661569',
  kuruDeposit: 'abi:0x4c3ae6c5cb499c7e14be5485e4c866d5a0cf9fd376d6d417b87b8bee09882c0a',
  kuruWithdraw: 'abi:0x1f8d34385430b9e8700a82ce0363bf308d2b912ba7d83c2157eaa25ec0b79245',
  kuruBatch: 'abi:0x52a7f0313269da737b4e09ca73c491c3cdf7b0e95e255446f74c8d6d95e4b3a4',
  perplExchange: 'abi:0x707f79244b442e26e2ddef60d36184989f95f4438fb3bca7f8b7f403ba2aa6e7',
  perplEnroll: 'typed_data:0x7686763c1dc183308e3eb0edecd9f61a0e10f57747fb5dab2c77674e9911c575',
  /** A condition Privy evaluates without decoding anything. */
  none: '-',
} as const;

type Blob = (typeof BLOB)[keyof typeof BLOB];

/**
 * A blob as the fingerprint names it: which key carried it and the hash of its
 * canonical form. Canonical, so key order and whitespace on the wire cannot
 * turn the right ABI into a refusal.
 */
function blobDigest(key: 'abi' | 'typed_data', blob: unknown): string {
  return `${key}:${keccak256(stringToBytes(canonicalize(blob)))}`;
}

/** A non-negative integer as Privy compares it: `0x`, lowercase, unpadded. */
function hexUint(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * One condition, reduced to what it means — including, since SEN-142, the
 * {@link BLOB} it decodes with.
 */
function condition(
  source: string,
  field: string,
  operator: string,
  value: string,
  blob: string = BLOB.none,
): string {
  return `${source}|${field}|${operator}|${value}|${blob}`;
}

/** A fingerprint with every blob dropped: only to word a refusal, never to accept one. */
function withoutBlobs(fingerprinted: string): string {
  return fingerprinted
    .split('&&')
    .map((c) => c.slice(0, c.lastIndexOf('|')))
    .join('&&');
}

const txTo = (address: Address) =>
  condition('ethereum_transaction', 'to', 'eq', getAddress(address));
const calldataEq = (abi: Blob, field: string, value: string) =>
  condition('ethereum_calldata', field, 'eq', value, abi);
const calldataLte = (abi: Blob, field: string, cap: bigint) =>
  condition('ethereum_calldata', field, 'lte', hexUint(cap), abi);

/** One rule as this module compares it: a method and an unordered set of conditions. */
export type ExpectedRule = { method: string; conditions: string[] };

/**
 * The rules a mandate must compile to — the mirror of `compileMandate` in
 * `@sente/mandate`, at the level of what each condition asserts.
 *
 * Kept in the same order and shape as the original so the two can be read side
 * by side when one changes.
 */
export function expectedPolicyRules(mandate: AgentMandate): ExpectedRule[] {
  const chain = condition('ethereum_transaction', 'chain_id', 'eq', hexUint(mandate.chainId));
  const expiry = condition('system', 'current_unix_timestamp', 'lte', String(mandate.expiresAt));
  const tx = (conditions: string[]): ExpectedRule => ({
    method: 'eth_signTransaction',
    conditions: [chain, expiry, ...conditions],
  });
  // The recovery rules carry no expiry: they can only move money toward the
  // owner, so an expired mandate must not strand collateral.
  const recovery = (conditions: string[]): ExpectedRule => ({
    method: 'eth_signTransaction',
    conditions: [chain, ...conditions],
  });

  const rules: ExpectedRule[] = [];
  if (mandate.venues.includes('kuru')) {
    for (const [key, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
      const token = getAddress(key);
      const deposit = [
        txTo(ACCOUNT_CORE),
        calldataEq(BLOB.kuruDeposit, 'deposit.token', token),
        calldataLte(BLOB.kuruDeposit, 'deposit.amount', cap),
      ];
      if (isAddressEqual(token, NATIVE_TOKEN)) {
        // Native MON has no approval: the money is the transaction's value.
        rules.push(
          tx([...deposit, condition('ethereum_transaction', 'value', 'lte', hexUint(cap))]),
        );
        continue;
      }
      rules.push(
        tx([
          txTo(token),
          calldataEq(BLOB.erc20Approve, 'approve.spender', ACCOUNT_CORE),
          calldataLte(BLOB.erc20Approve, 'approve.amount', cap),
        ]),
      );
      rules.push(tx(deposit));
    }
    for (const market of mandate.kuru.markets) {
      rules.push(tx([txTo(market), calldataEq(BLOB.kuruBatch, 'function_name', 'batch')]));
    }
    rules.push(
      recovery([txTo(ACCOUNT_CORE), calldataEq(BLOB.kuruWithdraw, 'function_name', 'withdraw')]),
    );
  }

  if (mandate.venues.includes('perpl')) {
    const cap = mandate.perpl.maxCollateralAtoms;
    rules.push(
      tx([
        txTo(COLLATERAL),
        calldataEq(BLOB.erc20Approve, 'approve.spender', EXCHANGE),
        calldataLte(BLOB.erc20Approve, 'approve.amount', cap),
      ]),
    );
    rules.push(
      tx([txTo(EXCHANGE), calldataLte(BLOB.perplExchange, 'createAccount.amountCNS', cap)]),
    );
    rules.push(
      tx([txTo(EXCHANGE), calldataEq(BLOB.perplExchange, 'function_name', 'allowOrderForwarding')]),
    );
    rules.push({
      method: 'eth_signTypedData_v4',
      conditions: [
        // Decimal here, hex on the transaction rules: Privy refuses hex for
        // this field (packages/mandate/src/privy/policy-types.ts).
        condition('ethereum_typed_data_domain', 'chainId', 'eq', String(mandate.chainId)),
        expiry,
        condition(
          'ethereum_typed_data_domain',
          'verifyingContract',
          'eq',
          ENROLL_VERIFYING_CONTRACT,
        ),
        condition(
          'ethereum_typed_data_message',
          'statement',
          'eq',
          PERPL_ENROLL_STATEMENT,
          BLOB.perplEnroll,
        ),
      ],
    });
  }

  // The way out, last, exactly as the compiler appends it: one transfer rule per
  // token, pinned to `returnTo`, with no expiry — an expired mandate must not
  // strand the money. Without a `returnTo` there is no transfer rule at all, and
  // the agent can send nothing anywhere (fail closed).
  rules.push(...expectedRecoveryRules(mandate, { withdraw: false }));
  return rules;
}

/**
 * The rules that can only move money TOWARD the owner, with the chain pinned and
 * no expiry: `AccountCore.withdraw`, which pays the agent's own wallet, and one
 * ERC-20 transfer per token pinned to `returnTo`.
 *
 * `withdraw` is a flag rather than always on because `expectedPolicyRules` emits
 * the withdraw rule in its own Kuru block, where the compiler does.
 */
function expectedRecoveryRules(
  mandate: AgentMandate,
  options: { withdraw: boolean },
): ExpectedRule[] {
  const chain = condition('ethereum_transaction', 'chain_id', 'eq', hexUint(mandate.chainId));
  const recovery = (conditions: string[]): ExpectedRule => ({
    method: 'eth_signTransaction',
    conditions: [chain, ...conditions],
  });
  const rules: ExpectedRule[] = [];
  if (options.withdraw && mandate.venues.includes('kuru')) {
    rules.push(
      recovery([txTo(ACCOUNT_CORE), calldataEq(BLOB.kuruWithdraw, 'function_name', 'withdraw')]),
    );
  }
  if (!mandate.returnTo) return rules;
  const owner = getAddress(mandate.returnTo);
  for (const token of RETURNABLE) {
    rules.push(recovery([txTo(token), calldataEq(BLOB.erc20Transfer, 'transfer.to', owner)]));
  }
  return rules;
}

/**
 * What a REVOKE must leave behind (SEN-17): the mandate's recovery rules, and
 * nothing else.
 *
 * Mirrors `compileRevocationRules`, and `approval.test.ts` pins the two equal the
 * same way it pins the amend compiler. Note what it does NOT include — no
 * approve, no deposit, no market, no enrollment — which is the property a revoke
 * has to keep: the agent stops, and only the exit stays open.
 */
export function expectedRevocationRules(mandate: AgentMandate): ExpectedRule[] {
  return expectedRecoveryRules(mandate, { withdraw: true });
}

/**
 * What this phone believes it is approving.
 *
 * A revoke carries the mandate too, since SEN-17: what it leaves behind is that
 * mandate's own way out, so the phone needs the mandate to know which rules to
 * expect — the same copy it would check an amend against.
 *
 * `ownWallet` is the signed-in user's own wallet as THIS PHONE knows it
 * (`session.wallet.address`: the Privy wallet registered under this phone's
 * device key), or `null` when the phone does not know it yet (SEN-124). It is
 * required rather than optional so no caller can forget it: a missing pin has
 * to be a decision someone typed, and `null` is refused.
 */
export type MandateChangeIntent = {
  kind: 'amend' | 'revoke';
  policyId: string;
  mandate: AgentMandate;
  ownWallet: Address | null;
};

/**
 * The address the recovery rules may pay, pinned to the phone's own knowledge
 * of the user's wallet (SEN-124, test-audit finding #1).
 *
 * Why this exists: the rule-set comparison proves the payload matches the
 * mandate, but for a revoke the mandate IS the server's (`agent.mandate`), and
 * for an amend its `returnTo` used to come from the server's copy too
 * (`formFromMandate`). A compromised API could therefore name an attacker as
 * `returnTo`, compile matching `transfer.to == attacker` rules, and the phone
 * would sign non-expiring rules that let the agent send every ERC-20 away. So
 * the destination is checked against the one address the phone did not take
 * from the agent: its own registered wallet.
 *
 * - No known wallet → refused. Never a fallback to the mandate's value: that
 *   value is exactly what is not trusted.
 * - An amend must name the wallet: the phone built that mandate from it, and
 *   the API fills the same address in when it is left out, so a missing one
 *   could only produce rules the phone would then have to take on faith.
 * - A revoke of a mandate with NO `returnTo` (hired before SEN-17) stays
 *   allowed: it compiles no transfer rule at all, so it can send nothing to
 *   anyone.
 */
function pinReturnTo(
  intent: MandateChangeIntent,
): { ok: true; mandate: AgentMandate } | { ok: false; problem: string } {
  if (!intent.ownWallet) return refuse('this phone doesn’t know your wallet yet');
  const named = intent.mandate.returnTo;
  if (!named) {
    return intent.kind === 'amend'
      ? refuse('it names no way out to your wallet')
      : { ok: true, mandate: intent.mandate };
  }
  if (!isAddressEqual(named, intent.ownWallet)) {
    return refuse(`it sends this agent’s funds to ${named}, which is not your wallet`);
  }
  // The mandate to build the expected rules from, with the destination replaced
  // by the phone's own copy: equal to the mandate's by the check above, but the
  // expected `transfer.to` then never depends on the server's value at all.
  return { ok: true, mandate: { ...intent.mandate, returnTo: getAddress(intent.ownWallet) } };
}

/**
 * Does `payload` do exactly what `intent` says, and nothing else?
 *
 * The one question worth asking before signing. See the module header for the
 * list; every `false` here is a refusal to sign, not a warning.
 */
export function verifyPolicyPatch(
  payload: AuthorizationPayload,
  intent: MandateChangeIntent,
): VerifyResult {
  if (payload.version !== 1) return refuse(`the payload is version ${String(payload.version)}`);
  if (payload.method !== 'PATCH') return refuse(`it is a ${payload.method}, not a policy change`);

  const expectedUrl = `${PRIVY_API_BASE}/v1/policies/${intent.policyId}`;
  if (payload.url !== expectedUrl) {
    return refuse(`it changes ${payload.url}, not this agent's policy`);
  }

  // SEN-142: the payload comes off the wire, so its type is a claim. Headers
  // that were not an object used to throw here instead of refusing, and any
  // truthy app id passed; `trade/envelope.ts` already held this line.
  const headers: unknown = payload.headers;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return refuse('it carries no headers');
  }
  const unexpected = Object.keys(headers).filter((name) => !ALLOWED_HEADERS.includes(name));
  if (unexpected.length > 0)
    return refuse(`it carries unexpected headers: ${unexpected.join(', ')}`);
  const appId = (headers as Record<string, unknown>)['privy-app-id'];
  if (typeof appId !== 'string' || appId === '') return refuse('it names no Privy app');

  const body = payload.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse('its body is not a policy update');
  }
  const bodyKeys = Object.keys(body as Record<string, unknown>);
  const extra = bodyKeys.filter((key) => key !== 'rules');
  if (extra.length > 0) return refuse(`its body also changes ${extra.join(', ')}`);

  const rules = (body as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return refuse('its body sets no rules');

  // SEN-124: the destination is checked against the phone's own wallet, and the
  // expected transfer rules are built from that wallet, not the server's copy.
  const pinned = pinReturnTo(intent);
  if (!pinned.ok) return pinned;
  const { mandate } = pinned;
  return compareRules(
    rules,
    intent.kind === 'revoke' ? expectedRevocationRules(mandate) : expectedPolicyRules(mandate),
  );
}

/** Rule-set equality, as multisets: order is Privy's business, content is ours. */
function compareRules(actual: unknown[], expected: ExpectedRule[]): VerifyResult {
  if (actual.length !== expected.length) {
    return refuse(
      `it sets ${actual.length} rule${actual.length === 1 ? '' : 's'}, and this mandate is ` +
        `${expected.length}`,
    );
  }
  // A count per distinct rule rather than an array to splice: two rules can be
  // identical (the same token capped twice), so this is a multiset, and it has
  // to stay one — matching by presence would let a duplicate stand in for a
  // rule that is missing.
  const remaining = new Map<string, number>();
  for (const rule of expected) {
    const key = fingerprint(rule);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const rule of actual) {
    const read = readRule(rule);
    if (!read.ok) return refuse(read.problem);
    const left = remaining.get(read.fingerprint) ?? 0;
    if (left === 0) {
      // SEN-142: a rule that would match but for its ABI or typed data is still
      // refused; it only gets a sentence that says which part is wrong.
      const bare = withoutBlobs(read.fingerprint);
      if (expected.some((rule) => withoutBlobs(fingerprint(rule)) === bare)) {
        return refuse(
          `rule “${read.label}” decodes with an ABI or typed data this app does not know`,
        );
      }
      return refuse(`it contains a rule this mandate does not: ${read.label}`);
    }
    remaining.set(read.fingerprint, left - 1);
  }
  return { ok: true };
}

function fingerprint(rule: ExpectedRule): string {
  return `${rule.method}::${[...rule.conditions].sort().join('&&')}`;
}

type ReadRule = { ok: true; fingerprint: string; label: string } | { ok: false; problem: string };

/** One rule off the wire, reduced to the same form {@link fingerprint} produces. */
function readRule(value: unknown): ReadRule {
  if (typeof value !== 'object' || value === null)
    return { ok: false, problem: 'a rule is not an object' };
  const rule = value as {
    name?: unknown;
    method?: unknown;
    action?: unknown;
    conditions?: unknown;
  };
  const label = typeof rule.name === 'string' && rule.name !== '' ? rule.name : 'unnamed';
  // Only ALLOW rules are ever compiled. A DENY here would mean the policy was
  // built by something else, and this app cannot reason about what it vetoes.
  if (rule.action !== 'ALLOW')
    return { ok: false, problem: `rule “${label}” is not an ALLOW rule` };
  if (typeof rule.method !== 'string')
    return { ok: false, problem: `rule “${label}” names no method` };
  if (!Array.isArray(rule.conditions)) {
    return { ok: false, problem: `rule “${label}” carries no conditions` };
  }
  const conditions: string[] = [];
  for (const raw of rule.conditions) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, problem: `rule “${label}” has a condition that is not an object` };
    }
    const {
      field_source: source,
      field,
      operator,
      value: bound,
      abi,
      typed_data: typedData,
    } = raw as Record<string, unknown>;
    if (
      typeof source !== 'string' ||
      typeof field !== 'string' ||
      typeof operator !== 'string' ||
      typeof bound !== 'string'
    ) {
      return { ok: false, problem: `rule “${label}” has a condition this app cannot read` };
    }
    // SEN-142: the blob is part of what the condition means, so it goes into
    // the fingerprint. The compiler never emits both on one condition, nor a
    // blob that cannot be canonicalized (a float, say), so neither is guessed at.
    if (abi !== undefined && typedData !== undefined) {
      return {
        ok: false,
        problem: `rule “${label}” has a condition with both an ABI and typed data`,
      };
    }
    let blob: string = BLOB.none;
    try {
      if (abi !== undefined) blob = blobDigest('abi', abi);
      else if (typedData !== undefined) blob = blobDigest('typed_data', typedData);
    } catch {
      return { ok: false, problem: `rule “${label}” has a condition this app cannot read` };
    }
    conditions.push(condition(source, field, operator, bound, blob));
  }
  // The same fingerprint function as the expected side, so a difference in how
  // the two are reduced can never be mistaken for a difference in the rules.
  return { ok: true, fingerprint: fingerprint({ method: rule.method, conditions }), label };
}

// The envelope rules, the refusal shape and the "no key" error are shared with
// the send flow (`wallet/send.ts`): one hardening, both paths. Re-exported so
// this module's callers keep importing them from here.
export { NoDeviceKeyError, type Approver, type VerifyResult };

/** A change the phone refused to sign, with the reason in the message. */
export class MandateApprovalRefusedError extends Error {
  readonly problem: string;

  constructor(problem: string) {
    super(
      `This change doesn’t match what you asked for, so it wasn’t signed: ${problem}. ` +
        'Nothing was changed.',
    );
    this.name = 'MandateApprovalRefusedError';
    this.problem = problem;
  }
}

/**
 * Prepare, verify, sign, commit — the whole amend for a device-owned agent.
 *
 * `prepared` can be passed in when the screen already asked for it to show the
 * confirmation sheet, so a user reads and approves ONE prepared change rather
 * than reading one and signing another.
 */
export function amendMandateWithApproval(
  api: AgentsApi,
  agent: Agent,
  mandate: AgentMandate,
  ownWallet: Address | null,
  sign: Approver | null,
  prepared?: PreparedMandateChange,
): Promise<Agent> {
  return approveChange(
    api,
    agent,
    { kind: 'amend', policyId: agent.policyId, mandate, ownWallet },
    sign,
    prepared,
  );
}

/**
 * The same for a revoke: the policy must be left with this agent's way out and
 * nothing else (SEN-17).
 *
 * The mandate the check compares against is the STORED one, `agent.mandate` — the
 * revoke is not a change to it, so there is no other copy that could be meant.
 * That copy comes from the server, which is why `ownWallet` is passed separately
 * and its `returnTo` is checked against it (SEN-124).
 */
export function revokeWithApproval(
  api: AgentsApi,
  agent: Agent,
  ownWallet: Address | null,
  sign: Approver | null,
  prepared?: PreparedMandateChange,
): Promise<Agent> {
  return approveChange(
    api,
    agent,
    { kind: 'revoke', policyId: agent.policyId, mandate: agent.mandate, ownWallet },
    sign,
    prepared,
  );
}

/**
 * The one flow both changes take, written once.
 *
 * Every step here is on the signing path, so the two must not drift: a check
 * added for the amend and forgotten for the revoke is a change nobody looked at
 * being signed. The only thing the two differ in is which pair of routes the
 * intent names.
 */
async function approveChange(
  api: AgentsApi,
  agent: Agent,
  intent: MandateChangeIntent,
  sign: Approver | null,
  prepared?: PreparedMandateChange,
): Promise<Agent> {
  if (!sign) throw new NoDeviceKeyError('changing this agent’s mandate');
  // SEN-124: a destination that cannot pass is refused before asking the API to
  // prepare anything. `verifyPolicyPatch` runs the same check again below, so a
  // `prepared` change handed in from a screen is held to it too.
  const pinned = pinReturnTo(intent);
  if (!pinned.ok) throw new MandateApprovalRefusedError(pinned.problem);
  const amending = intent.kind === 'amend';
  const change =
    prepared ??
    (amending
      ? await api.prepareAmendMandate(agent.id, intent.mandate)
      : await api.prepareRevoke(agent.id));

  const verdict = verifyPolicyPatch(change.payload, intent);
  if (!verdict.ok) throw new MandateApprovalRefusedError(verdict.problem);

  const approval = { prepareId: change.prepareId, signature: sign(change.payload) };
  return amending
    ? api.commitAmendMandate(agent.id, approval)
    : api.commitRevoke(agent.id, approval);
}

/**
 * Plain-language copy for anything that can stop an approval — the two local
 * refusals first, then the API's own reasons.
 *
 * The refused-here case is deliberately not softened: the user asked for one
 * change and the server proposed another, and they should read that as what it
 * is rather than as a network hiccup.
 */
export function describeApprovalError(error: unknown): { title: string; detail: string } {
  if (error instanceof MandateApprovalRefusedError) {
    return { title: 'This phone refused to sign it', detail: error.message };
  }
  if (error instanceof NoDeviceKeyError) {
    return { title: 'Sign in first', detail: error.message };
  }
  return describeAgentsError(error);
}

/** Whether changing this agent's mandate needs a signature from this phone. */
export function needsApproval(agent: Pick<Agent, 'ownerKind'>): boolean {
  return agent.ownerKind === 'device';
}
