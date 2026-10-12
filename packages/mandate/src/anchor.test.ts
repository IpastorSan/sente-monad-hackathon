/**
 * SEN-194: the mandate hash is deterministic across every representation of
 * one mandate, and moves with every field that changes what the agent may do.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { KURU_DEPLOYMENT } from '@sente/venues/kuru';

import {
  canonicalMandate,
  canonicalMandateJson,
  mandateHash,
  MANDATE_HASH_SCHEMA,
  normalizeDecimal,
  policyHash,
} from './anchor.ts';
import { parseMandate, type Mandate } from './mandate.ts';
import {
  demoMandate,
  demoMandateInput,
  MON_USDC,
  USDC,
  WBTC_USDC,
  WETH_USDC,
} from './mandate.fixture.ts';
import { compileMandate, compileRevocationRules } from './policy.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';

test('the hash is a 32-byte hex digest, stable across calls', () => {
  const hash = mandateHash(demoMandate());
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(mandateHash(demoMandate()), hash);
});

test('canonical JSON is sorted, compact, and names the schema and pinned contracts', () => {
  const json = canonicalMandateJson(demoMandate());
  assert.equal(json, JSON.stringify(JSON.parse(json)), 'no whitespace');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
  assert.equal(parsed['schema'], MANDATE_HASH_SCHEMA);
  assert.deepEqual(parsed['contracts'], {
    kuruDeployment: KURU_DEPLOYMENT.id,
    kuruAccountCore: KURU_DEPLOYMENT.contracts.accountCore,
    perplExchange: PERPL_TESTNET_CONTRACTS.exchange,
    perplCollateral: PERPL_TESTNET_CONTRACTS.collateral,
  });
});

test('one mandate, many spellings, one hash', () => {
  const base = mandateHash(parseMandate(demoMandateInput()));
  const input = demoMandateInput();
  const kuru = input['kuru'] as { markets: string[]; maxDepositAtoms: Record<string, string> };
  const perpl = input['perpl'] as { markets: string[] };
  // Reordered sets, reordered keys, uppercase-checksummed addresses, a trailing zero.
  const respelled = {
    maxOrderNotional: '250.50',
    perpl: { ...perpl, markets: [...perpl.markets].reverse() },
    kuru: {
      maxDepositAtoms: Object.fromEntries(Object.entries(kuru.maxDepositAtoms).reverse()),
      markets: [WETH_USDC, MON_USDC],
    },
    venues: ['perpl', 'kuru'],
    expiresAt: input['expiresAt'],
    chainId: input['chainId'],
    version: input['version'],
  };
  assert.equal(mandateHash(parseMandate(respelled)), base);
  // A bigint mandate and its JSON wire form agree.
  const wire = JSON.parse(
    JSON.stringify(demoMandate(), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;
  assert.equal(mandateHash(parseMandate(wire)), base);
});

test('every field that changes the authority changes the hash', () => {
  const base = demoMandate();
  const variants: Record<string, Mandate> = {
    expiresAt: { ...base, expiresAt: base.expiresAt + 1 },
    venues: { ...base, venues: ['kuru'] },
    'kuru.markets': { ...base, kuru: { ...base.kuru, markets: [...base.kuru.markets, WBTC_USDC] } },
    'kuru.maxDepositAtoms': {
      ...base,
      kuru: {
        ...base.kuru,
        maxDepositAtoms: { ...base.kuru.maxDepositAtoms, [USDC]: 1_000_000_001n },
      },
    },
    'perpl.maxCollateralAtoms': {
      ...base,
      perpl: { ...base.perpl, maxCollateralAtoms: base.perpl.maxCollateralAtoms + 1n },
    },
    'perpl.maxLeverage': { ...base, perpl: { ...base.perpl, maxLeverage: 5.5 } },
    'perpl.markets': { ...base, perpl: { ...base.perpl, markets: ['BTC-PERP'] } },
    maxOrderNotional: { ...base, maxOrderNotional: '250.51' },
    returnTo: { ...base, returnTo: OWNER },
    rollingCap: {
      ...base,
      rollingCap: { windowSeconds: 86_400, capAtoms: 1n, token: USDC },
    },
  };
  const seen = new Map<string, string>([[mandateHash(base), 'base']]);
  for (const [field, mandate] of Object.entries(variants)) {
    const hash = mandateHash(mandate);
    assert.ok(!seen.has(hash), `${field} collides with ${seen.get(hash)}`);
    seen.set(hash, field);
  }
  const capped = variants['rollingCap']!;
  assert.notEqual(
    mandateHash({ ...capped, rollingCap: { ...capped.rollingCap!, windowSeconds: 86_401 } }),
    mandateHash(capped),
  );
});

test('the Kuru deployment is part of the hash: Set C and Set D custody differ', () => {
  const mandate = demoMandate();
  assert.notEqual(
    mandateHash(mandate, { kuruDeployment: 'set-c' }),
    mandateHash(mandate, { kuruDeployment: 'set-d' }),
  );
  assert.equal(mandateHash(mandate), mandateHash(mandate, { kuruDeployment: KURU_DEPLOYMENT.id }));
});

test('normalizeDecimal drops trailing fraction zeros and nothing else', () => {
  assert.equal(normalizeDecimal('250.50'), '250.5');
  assert.equal(normalizeDecimal('7.000'), '7');
  assert.equal(normalizeDecimal('0.10'), '0.1');
  assert.equal(normalizeDecimal('100'), '100');
  assert.equal(normalizeDecimal('0'), '0');
  assert.equal(
    canonicalMandate(demoMandate({ maxOrderNotional: '10.0' }))['maxOrderNotional'],
    '10',
  );
});

test('policyHash is deterministic and tracks the compiled rules', () => {
  const mandate = demoMandate({ returnTo: OWNER });
  const rules = compileMandate(mandate);
  assert.equal(policyHash(compileMandate(mandate)), policyHash(rules));
  assert.match(policyHash(rules), /^0x[0-9a-f]{64}$/);
  // A cap change, a pin, and a revocation are each a different policy.
  const hashes = new Set([
    policyHash(rules),
    policyHash(compileMandate({ ...mandate, maxOrderNotional: '1' })), // layer 1 only
    policyHash(compileMandate({ ...mandate, perpl: { ...mandate.perpl, maxCollateralAtoms: 1n } })),
    policyHash(compileMandate(mandate, { agentAddress: AGENT })),
    policyHash(compileRevocationRules(mandate)),
  ]);
  // maxOrderNotional is enforced by Sente, not compiled: same policy, by design.
  assert.equal(hashes.size, KURU_DEPLOYMENT.custody === 'account-id' ? 4 : 3);
});
