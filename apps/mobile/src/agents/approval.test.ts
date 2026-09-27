/**
 * The phone's half of SEN-44: what it refuses to sign.
 *
 * The first test is the load-bearing one. `expectedPolicyRules` is a mirror of
 * `compileMandate`, and a mirror that has drifted would make this app refuse
 * changes the API composed correctly — or, worse, stop noticing an extra rule.
 * So it is pinned against the real `@sente/mandate`, which is a devDependency
 * resolved through `--conditions=source` (CLAUDE.md gotcha 10); the app itself
 * still imports nothing from it at runtime.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalize,
  compileMandate,
  compileRevocationRules,
  parseMandate,
  type PolicyCondition,
  type PolicyRule,
} from '@sente/mandate';
import {
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import { getAddress, keccak256, stringToBytes, type Address } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { toWireMandate, type AgentMandate } from './api.ts';
import {
  expectedPolicyRules,
  expectedRevocationRules,
  verifyPolicyPatch,
  type ExpectedRule,
  type MandateChangeIntent,
  type VerifyResult,
} from './approval.ts';
import { AUSD } from './mandate.ts';

const MARKET_A = KURU_TESTNET_MARKETS[0]!.address;
const MARKET_B = KURU_TESTNET_MARKETS[1]!.address;
const USDC = KURU_TESTNET_TOKENS.USDC.address as Address;
const MON = KURU_TESTNET_TOKENS.MON.address as Address;
const POLICY_ID = 'policy00000000000000test';
/** The owner's own wallet: the only address a compiled mandate lets funds reach. */
const OWNER = getAddress(`0x${'c'.repeat(40)}`);
/**
 * Somebody else (SEN-124). The fixtures above use `OWNER` on both sides — as the
 * mandate's `returnTo` and as the phone's wallet — which is exactly why no test
 * could see a server naming another address; this one lets the two differ.
 */
const ATTACKER = getAddress(`0x${'a'.repeat(40)}`);

/**
 * A mandate as the phone holds one in practice: its `returnTo` is the owner's
 * wallet, because the API sets it from the signed-in account (SEN-17) and an
 * amend is refused without it (SEN-124).
 */
function mandate(over: Partial<AgentMandate> = {}): AgentMandate {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru', 'perpl'],
    kuru: { markets: [MARKET_A], maxDepositAtoms: { [USDC]: 1_000_000_000n } },
    perpl: { maxCollateralAtoms: 500_000_000n, maxLeverage: 5, markets: ['BTC-PERP'] },
    maxOrderNotional: '250',
    returnTo: OWNER,
    ...over,
  };
}

/** A mandate with no way out at all — every agent hired before SEN-17. */
function noExit(over: Partial<AgentMandate> = {}): AgentMandate {
  const { returnTo: _none, ...rest } = mandate(over);
  return rest;
}

/** The API's own compiler, reduced to the form `expectedPolicyRules` produces. */
function compiled(m: AgentMandate): ExpectedRule[] {
  return compileMandate(parseMandate(toWireMandate(m))).map(toExpected);
}

function toExpected(rule: PolicyRule): ExpectedRule {
  return { method: rule.method, conditions: rule.conditions.map(conditionKey) };
}

/**
 * One compiled condition in the phone's form, blob included (SEN-142).
 *
 * Hashed here with the MANDATE package's canonicalizer, not the app's, so the
 * pinned hashes in `approval.ts` are checked against the real ABIs and typed
 * data by an independent path — this is what fails when Perpl's enrollment
 * struct drifts (CLAUDE.md gotcha 13) and the phone's pin has not followed.
 */
function conditionKey(c: PolicyCondition): string {
  const blob =
    'abi' in c
      ? `abi:${hash(c.abi)}`
      : 'typed_data' in c
        ? `typed_data:${hash(c.typed_data)}`
        : '-';
  return `${c.field_source}|${c.field}|${c.operator}|${c.value}|${blob}`;
}

function hash(blob: unknown): string {
  return keccak256(stringToBytes(canonicalize(blob)));
}

function normalise(rules: ExpectedRule[]): string[] {
  return rules.map((rule) => `${rule.method}::${[...rule.conditions].sort().join('&&')}`).sort();
}

/**
 * What the API sends back from `/prepare`, built from the real compiler.
 *
 * `null` is the empty policy a revoke used to leave; `{ revoke: m }` is what one
 * leaves since SEN-17 — that mandate's own way out.
 */
function payloadFor(
  m: AgentMandate | null | { revoke: AgentMandate },
  over: Record<string, unknown> = {},
) {
  const rules =
    m === null
      ? []
      : 'revoke' in m
        ? compileRevocationRules(parseMandate(toWireMandate(m.revoke)))
        : compileMandate(parseMandate(toWireMandate(m)));
  return {
    version: 1 as const,
    method: 'PATCH' as const,
    url: `https://api.privy.io/v1/policies/${POLICY_ID}`,
    body: { rules },
    headers: { 'privy-app-id': 'app-1' },
    ...over,
  };
}

/**
 * A refusal, for the reason given (SEN-142). `ok: false` alone passes for any
 * refusal — including one that fired for an unrelated reason while the check a
 * test is about was broken — so every refusal here names its sentence.
 */
function assertRefused(result: VerifyResult, reason: RegExp, message = ''): void {
  assert.equal(result.ok, false, message);
  assert.match(result.ok ? '' : result.problem, reason, message);
}

const amend = (m: AgentMandate, ownWallet: Address | null = OWNER): MandateChangeIntent => ({
  kind: 'amend',
  policyId: POLICY_ID,
  mandate: m,
  ownWallet,
});

const revoke = (m: AgentMandate, ownWallet: Address | null = OWNER): MandateChangeIntent => ({
  kind: 'revoke',
  policyId: POLICY_ID,
  mandate: m,
  ownWallet,
});

test('the mirrored compiler still agrees with @sente/mandate, mandate by mandate', () => {
  const cases: AgentMandate[] = [
    mandate(),
    mandate({ venues: ['kuru'] }),
    mandate({ venues: ['perpl'] }),
    mandate({ venues: [] }),
    mandate({ kuru: { markets: [MARKET_A, MARKET_B], maxDepositAtoms: { [USDC]: 5n } } }),
    // Native MON: no approval rule, and the cap is on the transaction's value.
    mandate({ kuru: { markets: [], maxDepositAtoms: { [MON]: 2_000_000_000_000_000_000n } } }),
    mandate({
      kuru: { markets: [MARKET_B], maxDepositAtoms: { [USDC]: 1n, [MON]: 3n } },
      perpl: { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] },
    }),
    mandate({ expiresAt: 1_900_000_000 }),
    // The way out (SEN-17): one transfer rule per token, and none of them expires.
    // `mandate()` carries one; these carry none, so both shapes stay pinned.
    noExit(),
    noExit({ venues: ['kuru'] }),
    noExit({ venues: [] }),
  ];
  for (const m of cases) {
    assert.deepEqual(
      normalise(expectedPolicyRules(m)),
      normalise(compiled(m)),
      `drifted for ${JSON.stringify(toWireMandate(m))}`,
    );
  }
});

test('a payload that is exactly the mandate’s own rules is approved', () => {
  const m = mandate();
  assert.deepEqual(verifyPolicyPatch(payloadFor(m), amend(m)), { ok: true });
});

test('a revoke is approved only when it leaves exactly the way out', () => {
  const m = mandate({ returnTo: OWNER });
  const intent = revoke(m);

  // The recovery rules, and nothing else: an exit stays open (SEN-17).
  assert.deepEqual(verifyPolicyPatch(payloadFor({ revoke: m }), intent), { ok: true });

  // A revoke that leaves the whole live policy in place is not a revoke.
  assertRefused(verifyPolicyPatch(payloadFor(m), intent), /it sets \d+ rules, and this mandate is/);

  // Neither is one that keeps a single rule the agent could take risk with: the
  // deposit rule, smuggled in beside the legitimate exit.
  const smuggled = payloadFor({ revoke: m });
  const withDeposit = [
    ...(smuggled.body.rules as PolicyRule[]),
    compileMandate(parseMandate(toWireMandate(m))).find((rule) =>
      rule.name.startsWith('Kuru: deposit'),
    )!,
  ];
  assertRefused(
    verifyPolicyPatch({ ...smuggled, body: { rules: withDeposit } }, intent),
    /it sets \d+ rules, and this mandate is/,
  );

  // And an empty policy no longer matches a mandate that HAS an exit: the phone
  // refuses to sign away the way out just as it refuses to widen the mandate.
  assertRefused(verifyPolicyPatch(payloadFor(null), intent), /it sets 0 rules/);

  // A mandate with no exit still revokes to nothing at all — every agent hired
  // before SEN-17 is in that state.
  assert.deepEqual(verifyPolicyPatch(payloadFor(null), revoke(noExit({ venues: ['perpl'] }))), {
    ok: true,
  });
});

test('the mirrored revocation rules still agree with @sente/mandate', () => {
  for (const m of [
    mandate({ returnTo: OWNER }),
    mandate({ venues: ['kuru'], returnTo: OWNER }),
    mandate({ venues: ['perpl'], returnTo: OWNER }),
    mandate({ venues: [], returnTo: OWNER }),
    noExit(),
    noExit({ venues: ['perpl'] }),
  ]) {
    assert.deepEqual(
      normalise(expectedRevocationRules(m)),
      normalise(compileRevocationRules(parseMandate(toWireMandate(m))).map(toExpected)),
      `drifted for ${JSON.stringify(toWireMandate(m))}`,
    );
  }
});

test('a raised cap the user did not type is refused', () => {
  const typed = mandate();
  // The API answers with a policy built from a LARGER cap: same shape, more
  // authority. This is the attack the device key exists to stop.
  const widened = mandate({
    kuru: { markets: [MARKET_A], maxDepositAtoms: { [USDC]: 9_000_000_000n } },
  });
  const result = verifyPolicyPatch(payloadFor(widened), amend(typed));
  assertRefused(result, /a rule this mandate does not: Kuru: approve USDC/);
});

test('one extra rule is refused, even when every rule the user typed is there', () => {
  const typed = mandate({ venues: ['kuru'] });
  const payload = payloadFor(typed);
  const rules = [...(payload.body.rules as PolicyRule[])];
  rules.push({
    name: 'Kuru: trade something else',
    method: 'eth_signTransaction',
    action: 'ALLOW',
    conditions: [
      { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: MARKET_B },
    ],
  } as PolicyRule);
  const result = verifyPolicyPatch({ ...payload, body: { rules } }, amend(typed));
  assertRefused(result, /it sets \d+ rules, and this mandate is/);
});

test('a longer expiry than the one on screen is refused', () => {
  const typed = mandate({ expiresAt: 1_800_000_000 });
  const stretched = mandate({ expiresAt: 2_100_000_000 });
  assertRefused(
    verifyPolicyPatch(payloadFor(stretched), amend(typed)),
    /a rule this mandate does not/,
  );
});

test('another agent’s policy, another host, another method: all refused', () => {
  const m = mandate();
  for (const [over, reason] of [
    [{ url: 'https://api.privy.io/v1/policies/somebody-elses-policy' }, /not this agent's policy/],
    [
      { url: `https://api.privy.io.evil.example/v1/policies/${POLICY_ID}` },
      /not this agent's policy/,
    ],
    [{ method: 'POST' as const }, /it is a POST, not a policy change/],
    [{ version: 2 }, /the payload is version 2/],
  ] as const) {
    assertRefused(verifyPolicyPatch(payloadFor(m, over), amend(m)), reason, JSON.stringify(over));
  }
});

test('a body or header the app did not expect is refused: both are signed bytes', () => {
  const m = mandate();
  const withName = verifyPolicyPatch(
    payloadFor(m, { body: { rules: compileMandate(parseMandate(toWireMandate(m))), name: 'x' } }),
    amend(m),
  );
  assertRefused(withName, /its body also changes name/);

  const withHeader = verifyPolicyPatch(
    payloadFor(m, { headers: { 'privy-app-id': 'app-1', 'x-forwarded-for': '1.2.3.4' } }),
    amend(m),
  );
  assertRefused(withHeader, /unexpected headers: x-forwarded-for/);
});

test('a DENY rule is refused rather than reasoned about', () => {
  const m = mandate({ venues: ['kuru'] });
  const payload = payloadFor(m);
  const rules = (payload.body.rules as PolicyRule[]).map((rule, index) =>
    index === 0 ? { ...rule, action: 'DENY' as const } : rule,
  );
  assertRefused(verifyPolicyPatch({ ...payload, body: { rules } }, amend(m)), /not an ALLOW rule/);
});

test('AUSD is the token the Perpl approval rule names', () => {
  // Pins the mirrored constant through the check that uses it, not just in
  // isolation: a wrong AUSD address would refuse every Perpl mandate.
  // The rule search runs on a mandate with no exit, so the AUSD return rule
  // cannot stand in for the approval rule this is about.
  assert.ok(
    expectedPolicyRules(noExit({ venues: ['perpl'] })).some((rule) =>
      rule.conditions.some((c) => c.includes(`|${AUSD.address}|`)),
    ),
  );
  const m = mandate({ venues: ['perpl'] });
  assert.deepEqual(verifyPolicyPatch(payloadFor(m), amend(m)), { ok: true });
});

// SEN-124 (test-audit finding #1). Every case below lets the mandate's
// `returnTo`, the payload's `transfer.to` and the phone's own wallet differ,
// which the fixtures above never do.

test('a revoke whose stored returnTo is not this phone’s wallet is refused, however consistent', () => {
  // The server's agent names the attacker, and its payload is compiled from that
  // very mandate, so rule-set equality alone holds. Only the pin catches it.
  const served = mandate({ returnTo: ATTACKER });
  const result = verifyPolicyPatch(payloadFor({ revoke: served }), revoke(served, OWNER));
  assertRefused(result, /not your wallet/);

  // `transfer.to` varied on its own: the right mandate with rules paying the
  // attacker, and the attacker's mandate with rules paying the owner.
  const typed = mandate({ returnTo: OWNER });
  assertRefused(
    verifyPolicyPatch(payloadFor({ revoke: served }), revoke(typed)),
    /a rule this mandate does not/,
  );
  assertRefused(
    verifyPolicyPatch(payloadFor({ revoke: typed }), revoke(served)),
    /not your wallet/,
  );

  // The owner spelled in lowercase is still the owner: the pin compares
  // addresses, so it does not refuse the one destination it exists to allow.
  const lower = mandate({ returnTo: OWNER.toLowerCase() as Address });
  assert.deepEqual(verifyPolicyPatch(payloadFor({ revoke: lower }), revoke(lower)), { ok: true });
});

test('an amend whose returnTo is not this phone’s wallet is refused, however consistent', () => {
  const served = mandate({ returnTo: ATTACKER });
  const result = verifyPolicyPatch(payloadFor(served), amend(served, OWNER));
  assertRefused(result, /not your wallet/);

  const typed = mandate({ returnTo: OWNER });
  assertRefused(
    verifyPolicyPatch(payloadFor(served), amend(typed)),
    /a rule this mandate does not/,
  );
  assertRefused(verifyPolicyPatch(payloadFor(typed), amend(served)), /not your wallet/);

  const lower = mandate({ returnTo: OWNER.toLowerCase() as Address });
  assert.deepEqual(verifyPolicyPatch(payloadFor(lower), amend(lower)), { ok: true });
});

test('a phone that does not know its wallet refuses, and never falls back to returnTo', () => {
  const m = mandate({ returnTo: OWNER });
  for (const [payload, intent] of [
    [payloadFor(m), amend(m, null)],
    [payloadFor({ revoke: m }), revoke(m, null)],
    // Even a revoke that could send nothing anywhere: with no wallet there is
    // nothing to check a destination against, so nothing is signed.
    [payloadFor(null), revoke(noExit(), null)],
  ] as const) {
    assertRefused(verifyPolicyPatch(payload, intent), /doesn’t know your wallet/, intent.kind);
  }
});

test('an amend that names no way out is refused', () => {
  // The API fills in a `returnTo` the phone did not send, so whatever transfer
  // rules it compiled could only be taken on faith.
  const bare = noExit();
  assertRefused(verifyPolicyPatch(payloadFor(bare), amend(bare)), /no way out/);
});

// SEN-142 (test-audit §2C, follow-up #19). The app id and the decoding blobs.

test('a payload that names no Privy app, or names it as anything but a string, is refused', () => {
  const m = mandate();
  // Kills the mutant that survived the audit (`approval.ts` app-id check): no
  // other test sends a payload without the header.
  assertRefused(verifyPolicyPatch(payloadFor(m, { headers: {} }), amend(m)), /names no Privy app/);
  assertRefused(
    verifyPolicyPatch(payloadFor(m, { headers: { 'privy-app-id': '' } }), amend(m)),
    /names no Privy app/,
  );
  // Failed before SEN-142: any truthy value passed the check.
  for (const appId of [['app-1'], 1, { id: 'app-1' }]) {
    const payload = payloadFor(m, { headers: { 'privy-app-id': appId } }) as AuthorizationPayload;
    assertRefused(
      verifyPolicyPatch(payload, amend(m)),
      /names no Privy app/,
      JSON.stringify(appId),
    );
  }
  // Failed before SEN-142: no headers object at all threw a TypeError out of
  // the verifier instead of returning a refusal.
  for (const headers of [undefined, null, ['privy-app-id']]) {
    const payload = payloadFor(m, { headers }) as AuthorizationPayload;
    assertRefused(verifyPolicyPatch(payload, amend(m)), /carries no headers/, String(headers));
  }
});

/** The compiled payload with one condition of one rule rewritten. */
function rewriteCondition(
  m: AgentMandate,
  rule: (r: PolicyRule) => boolean,
  condition: (c: PolicyCondition) => boolean,
  rewrite: (c: PolicyCondition) => Record<string, unknown>,
) {
  const payload = payloadFor(m);
  const rules = (payload.body.rules as PolicyRule[]).map((r) =>
    rule(r) ? { ...r, conditions: r.conditions.map((c) => (condition(c) ? rewrite(c) : c)) } : r,
  );
  assert.equal(
    rules.filter((r, i) => r !== (payload.body.rules as PolicyRule[])[i]).length,
    1,
    'the rewrite must hit exactly one rule',
  );
  return { ...payload, body: { rules } };
}

const isWithdraw = (r: PolicyRule) =>
  r.conditions.some((c) => c.field === 'function_name' && c.value === 'withdraw');
const isFunctionName = (c: PolicyCondition) => c.field === 'function_name';

test('a rule whose ABI is not the canonical one is refused, even when every value matches', () => {
  const m = mandate();
  // Fails before SEN-142. The attack from the audit: `function_name eq withdraw`
  // decoded with an ABI the server wrote, one that names `withdraw` over the
  // selector of a function that takes a recipient. Every value still matches.
  const lookalike = [
    {
      type: 'function',
      name: 'withdraw',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [],
    },
  ];
  for (const intent of [amend(m), revoke(m)]) {
    const base = intent.kind === 'revoke' ? payloadFor({ revoke: m }) : payloadFor(m);
    const rules = (base.body.rules as PolicyRule[]).map((r) =>
      isWithdraw(r)
        ? {
            ...r,
            conditions: r.conditions.map((c) => (isFunctionName(c) ? { ...c, abi: lookalike } : c)),
          }
        : r,
    );
    assertRefused(
      verifyPolicyPatch({ ...base, body: { rules } }, intent),
      /rule “Kuru: withdraw.*” decodes with an ABI or typed data this app does not know/,
      intent.kind,
    );
  }

  // A real ABI in the wrong place is no better: the deposit ABI on the withdraw rule.
  assertRefused(
    verifyPolicyPatch(
      rewriteCondition(m, isWithdraw, isFunctionName, (c) => ({
        ...c,
        abi: KURU_ACCOUNT_CORE_DEPOSIT_ABI,
      })),
      amend(m),
    ),
    /decodes with an ABI or typed data this app does not know/,
  );

  // Dropping the ABI, or moving it onto a condition that decodes nothing, is a
  // different condition too.
  assertRefused(
    verifyPolicyPatch(
      rewriteCondition(m, isWithdraw, isFunctionName, (c) => {
        const { abi: _abi, ...rest } = c as PolicyCondition & { abi: unknown };
        return rest;
      }),
      amend(m),
    ),
    /decodes with an ABI or typed data this app does not know/,
  );
  assertRefused(
    verifyPolicyPatch(
      rewriteCondition(
        m,
        isWithdraw,
        (c) => c.field === 'to',
        (c) => ({ ...c, abi: KURU_ACCOUNT_CORE_DEPOSIT_ABI }),
      ),
      amend(m),
    ),
    /decodes with an ABI or typed data this app does not know/,
  );

  // The canonical ABI with its keys in another order is the same ABI: the pin
  // is over the canonical form, so it refuses meaning, not spelling.
  const reordered = rewriteCondition(m, isWithdraw, isFunctionName, (c) => {
    const abi = (c as { abi: readonly Record<string, unknown>[] }).abi.map((entry) =>
      Object.fromEntries(Object.entries(entry).reverse()),
    );
    return { abi, ...c };
  });
  assert.deepEqual(verifyPolicyPatch(reordered, amend(m)), { ok: true });
});

test('an enrollment rule whose typed data is not the canonical struct is refused', () => {
  const m = mandate({ venues: ['perpl'] });
  const isEnroll = (r: PolicyRule) => r.method === 'eth_signTypedData_v4';
  const isStatement = (c: PolicyCondition) => c.field === 'statement';
  const typedData = (c: PolicyCondition) =>
    (c as Extract<PolicyCondition, { typed_data: unknown }>).typed_data;

  // Fails before SEN-142. `statement` read out of a different struct: here the
  // six-field one Perpl served until 2026-09-11, which is exactly the drift CLAUDE.md gotcha 13
  // describes — the phone must pin today's shape, not whatever it is sent.
  const stale = rewriteCondition(m, isEnroll, isStatement, (c) => {
    const td = typedData(c);
    return {
      ...c,
      typed_data: {
        ...td,
        types: { ...td.types, PerplRegisterApiKey: td.types['PerplRegisterApiKey']!.slice(0, 6) },
      },
    };
  });
  assertRefused(
    verifyPolicyPatch(stale, amend(m)),
    /rule “.*” decodes with an ABI or typed data this app does not know/,
  );

  // Another primary type over the same types.
  const retyped = rewriteCondition(m, isEnroll, isStatement, (c) => ({
    ...c,
    typed_data: { ...typedData(c), primary_type: 'EIP712Domain' },
  }));
  assertRefused(
    verifyPolicyPatch(retyped, amend(m)),
    /decodes with an ABI or typed data this app does not know/,
  );

  // The same blob under the other key is a different condition as well.
  const asAbi = rewriteCondition(m, isEnroll, isStatement, (c) => {
    const { typed_data: blob, ...rest } = c as PolicyCondition & { typed_data: unknown };
    return { ...rest, abi: blob };
  });
  assertRefused(
    verifyPolicyPatch(asAbi, amend(m)),
    /decodes with an ABI or typed data this app does not know/,
  );

  // Today's canonical shape, as the compiler emits it, still goes through.
  assert.deepEqual(verifyPolicyPatch(payloadFor(m), amend(m)), { ok: true });
});

test('a condition whose blob this app cannot read is refused, not guessed at', () => {
  const m = mandate();
  // Fails before SEN-142: the blobs were not read at all.
  const both = rewriteCondition(m, isWithdraw, isFunctionName, (c) => ({
    ...c,
    typed_data: { types: {}, primary_type: 'X' },
  }));
  assertRefused(
    verifyPolicyPatch(both, amend(m)),
    /has a condition with both an ABI and typed data/,
  );

  // A float cannot be canonicalized, so it cannot be hashed; the verifier says
  // so instead of throwing.
  const float = rewriteCondition(m, isWithdraw, isFunctionName, (c) => ({ ...c, abi: [0.5] }));
  assertRefused(verifyPolicyPatch(float, amend(m)), /has a condition this app cannot read/);
});
