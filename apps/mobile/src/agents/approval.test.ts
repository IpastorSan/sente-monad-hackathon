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
  compileMandate,
  compileRevocationRules,
  parseMandate,
  type PolicyRule,
} from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import { toWireMandate, type AgentMandate } from './api.ts';
import {
  expectedPolicyRules,
  expectedRevocationRules,
  verifyPolicyPatch,
  type ExpectedRule,
  type MandateChangeIntent,
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
  return {
    method: rule.method,
    conditions: rule.conditions.map((c) => `${c.field_source}|${c.field}|${c.operator}|${c.value}`),
  };
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
  assert.equal(verifyPolicyPatch(payloadFor(m), intent).ok, false);

  // Neither is one that keeps a single rule the agent could take risk with: the
  // deposit rule, smuggled in beside the legitimate exit.
  const smuggled = payloadFor({ revoke: m });
  const withDeposit = [
    ...(smuggled.body.rules as PolicyRule[]),
    compileMandate(parseMandate(toWireMandate(m))).find((rule) =>
      rule.name.startsWith('Kuru: deposit'),
    )!,
  ];
  assert.equal(verifyPolicyPatch({ ...smuggled, body: { rules: withDeposit } }, intent).ok, false);

  // And an empty policy no longer matches a mandate that HAS an exit: the phone
  // refuses to sign away the way out just as it refuses to widen the mandate.
  assert.equal(verifyPolicyPatch(payloadFor(null), intent).ok, false);

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
  assert.equal(result.ok, false);
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
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /rule/);
});

test('a longer expiry than the one on screen is refused', () => {
  const typed = mandate({ expiresAt: 1_800_000_000 });
  const stretched = mandate({ expiresAt: 2_100_000_000 });
  assert.equal(verifyPolicyPatch(payloadFor(stretched), amend(typed)).ok, false);
});

test('another agent’s policy, another host, another method: all refused', () => {
  const m = mandate();
  for (const over of [
    { url: 'https://api.privy.io/v1/policies/somebody-elses-policy' },
    { url: `https://api.privy.io.evil.example/v1/policies/${POLICY_ID}` },
    { method: 'POST' as const },
    { version: 2 },
  ]) {
    assert.equal(verifyPolicyPatch(payloadFor(m, over), amend(m)).ok, false, JSON.stringify(over));
  }
});

test('a body or header the app did not expect is refused: both are signed bytes', () => {
  const m = mandate();
  const withName = verifyPolicyPatch(
    payloadFor(m, { body: { rules: compileMandate(parseMandate(toWireMandate(m))), name: 'x' } }),
    amend(m),
  );
  assert.equal(withName.ok, false);

  const withHeader = verifyPolicyPatch(
    payloadFor(m, { headers: { 'privy-app-id': 'app-1', 'x-forwarded-for': '1.2.3.4' } }),
    amend(m),
  );
  assert.equal(withHeader.ok, false);
});

test('a DENY rule is refused rather than reasoned about', () => {
  const m = mandate({ venues: ['kuru'] });
  const payload = payloadFor(m);
  const rules = (payload.body.rules as PolicyRule[]).map((rule, index) =>
    index === 0 ? { ...rule, action: 'DENY' as const } : rule,
  );
  assert.equal(verifyPolicyPatch({ ...payload, body: { rules } }, amend(m)).ok, false);
});

test('AUSD is the token the Perpl approval rule names', () => {
  // Pins the mirrored constant through the check that uses it, not just in
  // isolation: a wrong AUSD address would refuse every Perpl mandate.
  // The rule search runs on a mandate with no exit, so the AUSD return rule
  // cannot stand in for the approval rule this is about.
  assert.ok(
    expectedPolicyRules(noExit({ venues: ['perpl'] })).some((rule) =>
      rule.conditions.some((c) => c.endsWith(`|${AUSD.address}`)),
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
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /not your wallet/);

  // `transfer.to` varied on its own: the right mandate with rules paying the
  // attacker, and the attacker's mandate with rules paying the owner.
  const typed = mandate({ returnTo: OWNER });
  assert.equal(verifyPolicyPatch(payloadFor({ revoke: served }), revoke(typed)).ok, false);
  assert.equal(verifyPolicyPatch(payloadFor({ revoke: typed }), revoke(served)).ok, false);

  // The owner spelled in lowercase is still the owner: the pin compares
  // addresses, so it does not refuse the one destination it exists to allow.
  const lower = mandate({ returnTo: OWNER.toLowerCase() as Address });
  assert.deepEqual(verifyPolicyPatch(payloadFor({ revoke: lower }), revoke(lower)), { ok: true });
});

test('an amend whose returnTo is not this phone’s wallet is refused, however consistent', () => {
  const served = mandate({ returnTo: ATTACKER });
  const result = verifyPolicyPatch(payloadFor(served), amend(served, OWNER));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /not your wallet/);

  const typed = mandate({ returnTo: OWNER });
  assert.equal(verifyPolicyPatch(payloadFor(served), amend(typed)).ok, false);
  assert.equal(verifyPolicyPatch(payloadFor(typed), amend(served)).ok, false);

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
    const result = verifyPolicyPatch(payload, intent);
    assert.equal(result.ok, false, intent.kind);
    assert.match(result.ok ? '' : result.problem, /doesn’t know your wallet/);
  }
});

test('an amend that names no way out is refused', () => {
  // The API fills in a `returnTo` the phone did not send, so whatever transfer
  // rules it compiled could only be taken on faith.
  const bare = noExit();
  const result = verifyPolicyPatch(payloadFor(bare), amend(bare));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /no way out/);
});
