/**
 * The hire form's mandate, checked against the API's own validator.
 *
 * `parseMandate` is imported from `@sente/mandate` — the exact function the
 * API runs on `POST /agents` — so a green run means the phone builds mandates
 * the server accepts, not merely mandates this file thinks look right.
 * `mise exec -- pnpm --filter @sente/mobile test` runs node with
 * `--conditions=source`, which is how these workspace imports load from src/.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import {
  PERPL_API_KEY_TYPED_DATA,
  PERPL_COLLATERAL_DECIMALS,
  PERPL_TESTNET_CONTRACTS,
} from '@sente/venues/perpl';
import type { Address } from 'viem';

import { toWireMandate, type AgentMandate } from './api.ts';
import {
  AUSD,
  PERPL_ENROLL_STATEMENT,
  PERPL_ENROLL_VERIFYING_CONTRACT,
  PERPL_EXCHANGE,
  buildMandate,
  defaultMandateForm,
  describeMandate,
  formatExpiry,
  formFromMandate,
  KURU_MARKETS,
  parsePerplMarkets,
  relevantDepositTokens,
  type MandateForm,
} from './mandate.ts';

const NOW = 1_789_000_000;
const DAY = 86_400;

function market(symbol: string): Address {
  const found = KURU_MARKETS.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`no market ${symbol}`);
  return found.address;
}

const USDC = KURU_TESTNET_TOKENS.USDC.address;
const MON = KURU_TESTNET_TOKENS.MON.address;
const WETH = KURU_TESTNET_TOKENS.WETH.address;

function form(patch: Partial<MandateForm> = {}): MandateForm {
  return { ...defaultMandateForm(NOW), ...patch };
}

/** Both venues, three caps, the shape a real hire sends. */
const BOTH: Partial<MandateForm> = {
  kuru: true,
  perpl: true,
  kuruMarkets: [market('MON-USDC'), market('WETH-USDC')],
  depositCaps: { USDC: '1000', MON: '5', WETH: '0.5' },
  perplCollateral: '500',
  perplMarkets: 'BTC-PERP, ETH-PERP',
  maxLeverage: '5',
  maxOrderNotional: '250.5',
  expiresAt: NOW + 30 * DAY,
};

function built(input: MandateForm): AgentMandate {
  const result = buildMandate(input, NOW);
  if (!result.ok) assert.fail(`expected a mandate, got ${JSON.stringify(result.errors)}`);
  return result.mandate;
}

/** Through JSON exactly as the request body carries it, then the API's validator. */
function serverParse(mandate: AgentMandate) {
  return parseMandate(JSON.parse(JSON.stringify(toWireMandate(mandate))));
}

test('AUSD mirrors the Perpl collateral token in @sente/venues/perpl', () => {
  assert.equal(AUSD.address, PERPL_TESTNET_CONTRACTS.collateral);
  assert.equal(AUSD.decimals, PERPL_COLLATERAL_DECIMALS);
});

test('the mirrored Perpl policy constants still match @sente/venues/perpl', () => {
  // If one of these drifts, the app refuses to approve a Perpl mandate it in
  // fact typed — fail closed, but only this test says why.
  assert.equal(PERPL_EXCHANGE, PERPL_TESTNET_CONTRACTS.exchange);
  assert.equal(PERPL_ENROLL_VERIFYING_CONTRACT, PERPL_API_KEY_TYPED_DATA.domain.verifyingContract);
  assert.equal(PERPL_ENROLL_STATEMENT, PERPL_API_KEY_TYPED_DATA.statement);
});

test('the default form builds a mandate the API accepts', () => {
  const parsed = serverParse(built(form()));
  assert.deepEqual(parsed.venues, ['kuru']);
  assert.deepEqual(parsed.kuru.markets, [market('MON-USDC')]);
  assert.equal(parsed.kuru.maxDepositAtoms[USDC], 100_000_000n);
  assert.equal(parsed.expiresAt, NOW + 7 * DAY);
});

test('a two-venue form builds exactly these atoms, and the API accepts them', () => {
  const mandate = built(form(BOTH));
  assert.deepEqual(mandate.kuru.maxDepositAtoms, {
    [USDC]: 1_000_000_000n,
    [MON]: 5_000_000_000_000_000_000n,
    [WETH]: 500_000_000_000_000_000n,
  });
  assert.equal(mandate.perpl.maxCollateralAtoms, 500_000_000n);

  const parsed = serverParse(mandate);
  assert.deepEqual(parsed.venues, ['kuru', 'perpl']);
  assert.deepEqual(parsed.perpl, {
    maxCollateralAtoms: 500_000_000n,
    maxLeverage: 5,
    markets: ['BTC-PERP', 'ETH-PERP'],
  });
  assert.equal(parsed.maxOrderNotional, '250.5');
});

test('a switched-off venue carries an empty allowlist, whatever the form still holds', () => {
  const mandate = built(form({ ...BOTH, kuru: false }));
  assert.deepEqual(mandate.kuru, { markets: [], maxDepositAtoms: {} });

  const kuruOnly = built(form({ ...BOTH, perpl: false }));
  assert.deepEqual(kuruOnly.perpl, { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] });
  assert.deepEqual(serverParse(kuruOnly).venues, ['kuru']);
});

test('caps are kept only for tokens the chosen markets trade', () => {
  assert.deepEqual(
    relevantDepositTokens([market('MON-USDC'), market('WETH-USDC')]).map((t) => t.symbol),
    ['MON', 'USDC', 'WETH'],
  );
  const mandate = built(
    form({ kuruMarkets: [market('MON-USDC')], depositCaps: { USDC: '1', WETH: '2' } }),
  );
  assert.deepEqual(Object.keys(mandate.kuru.maxDepositAtoms), [USDC]);
});

test('each field refuses with its own message', () => {
  const refused = (patch: Partial<MandateForm>) => {
    const result = buildMandate(form(patch), NOW);
    assert.equal(result.ok, false);
    return result.ok ? {} : result.errors;
  };
  assert.ok(refused({ kuru: false, perpl: false }).venues);
  assert.ok(refused({ kuruMarkets: [] }).kuruMarkets);
  assert.ok(refused({ depositCaps: { USDC: '1.0000001' } }).depositCaps, 'USDC has 6 decimals');
  assert.ok(refused({ depositCaps: {} }).depositCaps, 'no cap at all cannot fund an order');
  assert.ok(refused({ maxOrderNotional: '0' }).maxOrderNotional);
  assert.ok(refused({ maxOrderNotional: '1e3' }).maxOrderNotional);
  assert.ok(refused({ expiresAt: NOW - 1 }).expiresAt);

  const perpl = refused({
    perpl: true,
    perplCollateral: '',
    perplMarkets: ' , ',
    maxLeverage: '0',
  });
  assert.ok(perpl.perplCollateral);
  assert.ok(perpl.perplMarkets);
  assert.ok(perpl.maxLeverage);
});

test('parsePerplMarkets splits on commas and spaces and drops repeats', () => {
  assert.deepEqual(parsePerplMarkets(' BTC-PERP, ETH-PERP  BTC-PERP,'), ['BTC-PERP', 'ETH-PERP']);
  assert.deepEqual(parsePerplMarkets(''), []);
});

test('formFromMandate is the inverse of buildMandate, for amending', () => {
  const mandate = built(form(BOTH));
  assert.deepEqual(built(formFromMandate(mandate)), mandate);
});

// The acceptance criterion: the review step says who enforces each limit.
test('the review labels Kuru deposits, markets, Perpl collateral and expiry as enclave; size, leverage and Perpl markets as Sente', () => {
  const enforcers = Object.fromEntries(
    describeMandate(built(form(BOTH))).map((limit) => [limit.id, limit.enforcer]),
  );
  assert.deepEqual(enforcers, {
    'kuru.markets': 'enclave',
    'kuru.deposit.MON': 'enclave',
    'kuru.deposit.USDC': 'enclave',
    'kuru.deposit.WETH': 'enclave',
    'perpl.collateral': 'enclave',
    'perpl.markets': 'sente',
    'perpl.leverage': 'sente',
    maxOrderNotional: 'sente',
    expiresAt: 'enclave',
  });
});

test('the review states each limit in units a person reads', () => {
  const values = Object.fromEntries(
    describeMandate(built(form(BOTH))).map((limit) => [limit.id, limit.value]),
  );
  assert.equal(values['kuru.markets'], 'MON-USDC, WETH-USDC');
  assert.equal(values['kuru.deposit.USDC'], '1,000 USDC');
  assert.equal(values['kuru.deposit.WETH'], '0.5 WETH');
  assert.equal(values['perpl.collateral'], '500 AUSD');
  assert.equal(values['perpl.leverage'], '5×');
  assert.equal(values.maxOrderNotional, '250.5 in quote units');
  assert.equal(values.expiresAt, formatExpiry(NOW + 30 * DAY));
  // 1,789,000,000 s = 20,706 days + 1,600 s after the epoch.
  assert.equal(formatExpiry(1_789_000_000), '2026-09-10 00:26 UTC');
});

test('a Kuru-only mandate lists no Perpl limits', () => {
  const ids = describeMandate(built(form())).map((limit) => limit.id);
  assert.ok(!ids.some((id) => id.startsWith('perpl.')));
});
