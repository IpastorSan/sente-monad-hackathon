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
 * 3. `headers` carries only `privy-app-id` (and, if present, an idempotency
 *    key), because the headers are signed too.
 * 4. `body` has exactly one key, `rules`.
 * 5. For a revoke, `rules` is `[]` — a policy with no rules signs nothing.
 * 6. For an amend, the rules are EXACTLY the rules the mandate compiles to:
 *    same set of rules, each with the same method and the same set of
 *    conditions, compared as `field_source|field|operator|value`. Not a subset,
 *    not "nothing worse than" — equal. One extra rule is one extra thing the
 *    agent could sign.
 *
 * The comparison ignores each condition's `abi` and `typed_data` blobs, which
 * say how Privy decodes calldata to evaluate a condition. A wrong one can only
 * stop a rule matching, never widen it, and mirroring the ABIs here would mean
 * mirroring Perpl's drifting enrollment struct (CLAUDE.md gotcha 13) on the
 * security path.
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
 * KNOWN LIMIT: `mandate.returnTo` (the recovery rules) has no field in this
 * app's mandate, so it never sends one and never expects its rules. An agent
 * whose mandate carries one cannot be amended from the phone until the form
 * carries it too — the check would refuse the extra rules, which is the right
 * way round to be wrong.
 *
 * Plain TS, no React Native: `approval.test.ts` runs under plain node.
 */
import { KURU_TESTNET_CONTRACTS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { getAddress, isAddressEqual, type Address } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
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

/** Privy's own API. The URL is part of the signed bytes, so it is pinned here. */
const PRIVY_API_BASE = 'https://api.privy.io';

/** Headers a payload may carry. Anything else is unsigned by us, so unsignable. */
const ALLOWED_HEADERS = ['privy-app-id', 'privy-idempotency-key'];

/** A non-negative integer as Privy compares it: `0x`, lowercase, unpadded. */
function hexUint(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * One condition, reduced to what it means. `abi` and `typed_data` are dropped;
 * see the module header.
 */
function condition(source: string, field: string, operator: string, value: string): string {
  return `${source}|${field}|${operator}|${value}`;
}

const txTo = (address: Address) =>
  condition('ethereum_transaction', 'to', 'eq', getAddress(address));
const calldataEq = (field: string, value: string) =>
  condition('ethereum_calldata', field, 'eq', value);
const calldataLte = (field: string, cap: bigint) =>
  condition('ethereum_calldata', field, 'lte', hexUint(cap));

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
    const accountCore = KURU_TESTNET_CONTRACTS.accountCore;
    for (const [key, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
      const token = getAddress(key);
      const deposit = [
        txTo(accountCore),
        calldataEq('deposit.token', token),
        calldataLte('deposit.amount', cap),
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
          calldataEq('approve.spender', getAddress(accountCore)),
          calldataLte('approve.amount', cap),
        ]),
      );
      rules.push(tx(deposit));
    }
    for (const market of mandate.kuru.markets) {
      rules.push(tx([txTo(market), calldataEq('function_name', 'batch')]));
    }
    rules.push(recovery([txTo(accountCore), calldataEq('function_name', 'withdraw')]));
  }

  if (mandate.venues.includes('perpl')) {
    const cap = mandate.perpl.maxCollateralAtoms;
    rules.push(
      tx([
        txTo(AUSD.address),
        calldataEq('approve.spender', getAddress(PERPL_EXCHANGE)),
        calldataLte('approve.amount', cap),
      ]),
    );
    rules.push(tx([txTo(PERPL_EXCHANGE), calldataLte('createAccount.amountCNS', cap)]));
    rules.push(tx([txTo(PERPL_EXCHANGE), calldataEq('function_name', 'allowOrderForwarding')]));
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
          getAddress(PERPL_ENROLL_VERIFYING_CONTRACT),
        ),
        condition('ethereum_typed_data_message', 'statement', 'eq', PERPL_ENROLL_STATEMENT),
      ],
    });
  }
  return rules;
}

/** What this phone believes it is approving. */
export type MandateChangeIntent =
  { kind: 'amend'; policyId: string; mandate: AgentMandate } | { kind: 'revoke'; policyId: string };

/** `ok` or a sentence a person can act on. Never "invalid". */
export type VerifyResult = { ok: true } | { ok: false; problem: string };

const refuse = (problem: string): VerifyResult => ({ ok: false, problem });

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

  const headers = Object.keys(payload.headers ?? {});
  const unexpected = headers.filter((name) => !ALLOWED_HEADERS.includes(name));
  if (unexpected.length > 0)
    return refuse(`it carries unexpected headers: ${unexpected.join(', ')}`);
  if (!payload.headers['privy-app-id']) return refuse('it names no Privy app');

  const body = payload.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse('its body is not a policy update');
  }
  const bodyKeys = Object.keys(body as Record<string, unknown>);
  const extra = bodyKeys.filter((key) => key !== 'rules');
  if (extra.length > 0) return refuse(`its body also changes ${extra.join(', ')}`);

  const rules = (body as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return refuse('its body sets no rules');

  if (intent.kind === 'revoke') {
    return rules.length === 0
      ? { ok: true }
      : refuse(`a revoke must leave no rules, and this leaves ${rules.length}`);
  }
  return compareRules(rules, expectedPolicyRules(intent.mandate));
}

/** Rule-set equality, as multisets: order is Privy's business, content is ours. */
function compareRules(actual: unknown[], expected: ExpectedRule[]): VerifyResult {
  if (actual.length !== expected.length) {
    return refuse(
      `it sets ${actual.length} rule${actual.length === 1 ? '' : 's'}, and this mandate is ` +
        `${expected.length}`,
    );
  }
  const remaining = expected.map(fingerprint);
  for (const rule of actual) {
    const read = readRule(rule);
    if (!read.ok) return refuse(read.problem);
    const index = remaining.indexOf(read.fingerprint);
    if (index === -1) {
      return refuse(`it contains a rule this mandate does not: ${read.label}`);
    }
    remaining.splice(index, 1);
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
    const { field_source: source, field, operator, value: bound } = raw as Record<string, unknown>;
    if (
      typeof source !== 'string' ||
      typeof field !== 'string' ||
      typeof operator !== 'string' ||
      typeof bound !== 'string'
    ) {
      return { ok: false, problem: `rule “${label}” has a condition this app cannot read` };
    }
    conditions.push(condition(source, field, operator, bound));
  }
  // The same fingerprint function as the expected side, so a difference in how
  // the two are reduced can never be mistaken for a difference in the rules.
  return { ok: true, fingerprint: fingerprint({ method: rule.method, conditions }), label };
}

/** Signs one Privy authorization payload with the device key, or is `null` when signed out. */
export type Approver = (payload: AuthorizationPayload) => string;

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

/** No device key in this session — sign in again before approving anything. */
export class NoDeviceKeyError extends Error {
  constructor() {
    super('Sign in with your passkey before changing this agent’s mandate.');
    this.name = 'NoDeviceKeyError';
  }
}

/**
 * Prepare, verify, sign, commit — the whole amend for a device-owned agent.
 *
 * `prepared` can be passed in when the screen already asked for it to show the
 * confirmation sheet, so a user reads and approves ONE prepared change rather
 * than reading one and signing another.
 */
export async function amendMandateWithApproval(
  api: AgentsApi,
  agent: Agent,
  mandate: AgentMandate,
  sign: Approver | null,
  prepared?: PreparedMandateChange,
): Promise<Agent> {
  if (!sign) throw new NoDeviceKeyError();
  const change = prepared ?? (await api.prepareAmendMandate(agent.id, mandate));
  const verdict = verifyPolicyPatch(change.payload, {
    kind: 'amend',
    policyId: agent.policyId,
    mandate,
  });
  if (!verdict.ok) throw new MandateApprovalRefusedError(verdict.problem);
  return api.commitAmendMandate(agent.id, {
    prepareId: change.prepareId,
    signature: sign(change.payload),
  });
}

/** The same for a revoke: the policy must be left with no rules at all. */
export async function revokeWithApproval(
  api: AgentsApi,
  agent: Agent,
  sign: Approver | null,
  prepared?: PreparedMandateChange,
): Promise<Agent> {
  if (!sign) throw new NoDeviceKeyError();
  const change = prepared ?? (await api.prepareRevoke(agent.id));
  const verdict = verifyPolicyPatch(change.payload, {
    kind: 'revoke',
    policyId: agent.policyId,
  });
  if (!verdict.ok) throw new MandateApprovalRefusedError(verdict.problem);
  return api.commitRevoke(agent.id, {
    prepareId: change.prepareId,
    signature: sign(change.payload),
  });
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
