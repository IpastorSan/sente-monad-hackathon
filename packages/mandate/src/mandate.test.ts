import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';

import { compareDecimal } from './decimal.ts';
import { MandateError, parseMandate } from './mandate.ts';
import { demoMandateInput, EXPIRES_AT, MON, MON_USDC, USDC, WETH_USDC } from './mandate.fixture.ts';

function withPatch(patch: (input: Record<string, unknown>) => void): Record<string, unknown> {
  const input = demoMandateInput();
  patch(input);
  return input;
}

const kuruOf = (input: Record<string, unknown>) => input.kuru as Record<string, unknown>;
const perplOf = (input: Record<string, unknown>) => input.perpl as Record<string, unknown>;

function rejects(input: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseMandate(input),
    (error: unknown) => error instanceof MandateError && pattern.test(error.reason),
  );
}

test('parseMandate checksums addresses and turns atom strings into bigints', () => {
  const mandate = parseMandate(demoMandateInput());
  assert.deepEqual(mandate.kuru.markets, [MON_USDC, WETH_USDC]);
  assert.equal(mandate.kuru.maxDepositAtoms[USDC], 1_000_000_000n);
  assert.equal(mandate.kuru.maxDepositAtoms[MON], 5_000_000_000_000_000_000n);
  assert.equal(mandate.perpl.maxCollateralAtoms, 500_000_000n);
  assert.equal(mandate.expiresAt, EXPIRES_AT);
  assert.equal(mandate.rollingCap, undefined);
});

test('parseMandate accepts bigint atoms as they are', () => {
  const input = withPatch((m) => (perplOf(m).maxCollateralAtoms = 7n));
  assert.equal(parseMandate(input).perpl.maxCollateralAtoms, 7n);
});

test('amounts are never JS numbers — not floats, not even integers', () => {
  rejects(
    withPatch((m) => (perplOf(m).maxCollateralAtoms = 0.5)),
    /never a JS number/,
  );
  rejects(
    withPatch((m) => (perplOf(m).maxCollateralAtoms = 500)),
    /never a JS number/,
  );
  rejects(
    withPatch((m) => (perplOf(m).maxCollateralAtoms = '1e6')),
    /never a JS number/,
  );
  rejects(
    withPatch((m) => (perplOf(m).maxCollateralAtoms = -1n)),
    /negative/,
  );
  rejects(
    withPatch((m) => (m.maxOrderNotional = 250.5)),
    /maxOrderNotional/,
  );
  rejects(
    withPatch((m) => (m.maxOrderNotional = '1e3')),
    /maxOrderNotional/,
  );
});

test('every field is required, and a misspelt field fails rather than vanishing', () => {
  rejects(
    withPatch((m) => delete m.perpl),
    /perpl must be an object/,
  );
  rejects(
    withPatch((m) => delete m.venues),
    /venues must be an array/,
  );
  rejects(
    withPatch((m) => (m.rolingCap = {})),
    /rolingCap is not a mandate field/,
  );
  rejects(
    withPatch((m) => (kuruOf(m).market = [])),
    /kuru.market is not a mandate field/,
  );
  rejects(null, /mandate must be an object/);
});

test('version and chain are pinned', () => {
  rejects(
    withPatch((m) => (m.version = 2)),
    /version/,
  );
  rejects(
    withPatch((m) => (m.chainId = 1)),
    /chainId/,
  );
});

test('expiresAt is unix seconds — a millisecond timestamp would never expire', () => {
  rejects(
    withPatch((m) => (m.expiresAt = EXPIRES_AT * 1000)),
    /milliseconds/,
  );
  rejects(
    withPatch((m) => (m.expiresAt = 1.5)),
    /unix seconds/,
  );
  rejects(
    withPatch((m) => (m.expiresAt = '2000000000')),
    /unix seconds/,
  );
});

test('venues must be known and listed once', () => {
  rejects(
    withPatch((m) => (m.venues = ['kuru', 'hyperliquid'])),
    /hyperliquid is not a venue/,
  );
  rejects(
    withPatch((m) => (m.venues = ['kuru', 'kuru'])),
    /twice/,
  );
});

test('Kuru markets and tokens must be real testnet contracts, correctly checksummed', () => {
  const stranger = '0x000000000000000000000000000000000000dEaD';
  rejects(
    withPatch((m) => (kuruOf(m).markets = [stranger])),
    /not a Kuru testnet market/,
  );
  rejects(
    withPatch((m) => (kuruOf(m).markets = [MON_USDC, MON_USDC.toLowerCase()])),
    /twice/,
  );
  rejects(
    withPatch((m) => (kuruOf(m).maxDepositAtoms = { [stranger]: '1' })),
    /not a Kuru testnet token/,
  );
  // Flip one letter's case: a mixed-case address with a broken checksum is refused.
  const broken = MON_USDC.replace('b', 'B');
  assert.notEqual(broken, MON_USDC);
  rejects(
    withPatch((m) => (kuruOf(m).markets = [broken])),
    /EIP-55/,
  );
});

test('empty allowlists parse — the refusal happens when something is attempted', () => {
  const mandate = parseMandate(
    withPatch((m) => {
      kuruOf(m).markets = [];
      kuruOf(m).maxDepositAtoms = {};
      perplOf(m).markets = [];
      m.venues = [];
    }),
  );
  assert.deepEqual(mandate.venues, []);
  assert.deepEqual(mandate.kuru.markets, []);
});

test('perpl leverage and markets are validated', () => {
  rejects(
    withPatch((m) => (perplOf(m).maxLeverage = 0)),
    /maxLeverage/,
  );
  rejects(
    withPatch((m) => (perplOf(m).maxLeverage = Infinity)),
    /maxLeverage/,
  );
  rejects(
    withPatch((m) => (perplOf(m).markets = ['BTC-PERP', 'BTC-PERP'])),
    /twice/,
  );
  rejects(
    withPatch((m) => (perplOf(m).markets = [' BTC-PERP'])),
    /market symbol/,
  );
});

test('rollingCap: Privy window bounds, a positive cap, and a token the mandate funds', () => {
  const rolling = (value: Record<string, unknown>) => withPatch((m) => (m.rollingCap = value));
  const ok = parseMandate(rolling({ windowSeconds: 86_400, capAtoms: '2000000000', token: USDC }));
  assert.deepEqual(ok.rollingCap, { windowSeconds: 86_400, capAtoms: 2_000_000_000n, token: USDC });

  const ausd = PERPL_TESTNET_CONTRACTS.collateral;
  assert.equal(
    parseMandate(rolling({ windowSeconds: 3_600, capAtoms: '1', token: ausd })).rollingCap?.token,
    ausd,
  );

  rejects(rolling({ windowSeconds: 3_599, capAtoms: '1', token: USDC }), /windowSeconds/);
  rejects(rolling({ windowSeconds: 259_201, capAtoms: '1', token: USDC }), /windowSeconds/);
  rejects(rolling({ windowSeconds: 3_600, capAtoms: '0', token: USDC }), /positive/);
  rejects(
    rolling({ windowSeconds: 3_600, capAtoms: '1', token: MON }),
    /not an ERC-20 this mandate funds/,
  );
});

test('compareDecimal is exact where a float is not', () => {
  assert.equal(compareDecimal('250.5', '250.50'), 0);
  assert.equal(compareDecimal('250.50000000000000001', '250.5'), 1);
  assert.equal(compareDecimal('9', '10'), -1);
  assert.equal(compareDecimal('0.1', '0.09'), 1);
  assert.throws(() => compareDecimal('-1', '1'), /not a decimal/);
});
