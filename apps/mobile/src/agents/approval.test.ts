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

import { compileMandate, parseMandate, type PolicyRule } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { toWireMandate, type AgentMandate } from './api.ts';
import {
  expectedPolicyRules,
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

function mandate(over: Partial<AgentMandate> = {}): AgentMandate {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru', 'perpl'],
    kuru: { markets: [MARKET_A], maxDepositAtoms: { [USDC]: 1_000_000_000n } },
    perpl: { maxCollateralAtoms: 500_000_000n, maxLeverage: 5, markets: ['BTC-PERP'] },
    maxOrderNotional: '250',
    ...over,
  };
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

/** What the API sends back from `/prepare`, built from the real compiler. */
function payloadFor(m: AgentMandate | null, over: Record<string, unknown> = {}) {
  const rules = m === null ? [] : compileMandate(parseMandate(toWireMandate(m)));
  return {
    version: 1 as const,
    method: 'PATCH' as const,
    url: `https://api.privy.io/v1/policies/${POLICY_ID}`,
    body: { rules },
    headers: { 'privy-app-id': 'app-1' },
    ...over,
  };
}

const amend = (m: AgentMandate): MandateChangeIntent => ({
  kind: 'amend',
  policyId: POLICY_ID,
  mandate: m,
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

test('a revoke is approved only when it leaves no rules at all', () => {
  const intent: MandateChangeIntent = { kind: 'revoke', policyId: POLICY_ID };
  assert.deepEqual(verifyPolicyPatch(payloadFor(null), intent), { ok: true });

  const sneaky = verifyPolicyPatch(payloadFor(mandate()), intent);
  assert.equal(sneaky.ok, false);
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
  const m = mandate({ venues: ['perpl'] });
  assert.ok(
    expectedPolicyRules(m).some((rule) =>
      rule.conditions.some((c) => c.endsWith(`|${AUSD.address}`)),
    ),
  );
  assert.deepEqual(verifyPolicyPatch(payloadFor(m), amend(m)), { ok: true });
});
