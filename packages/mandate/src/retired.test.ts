import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KURU_RETIRED_DEPLOYMENT, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import { compileMandate } from './policy.ts';
import { demoMandate, MON, MON_USDC, USDC, WBTC_USDC, WETH_USDC } from './mandate.fixture.ts';
import { parseMandate, MandateError } from './mandate.ts';
import { retiredKuruMessage, retiredKuruReferences, withCurrentKuru } from './retired.ts';

const old = (symbol: string): Address =>
  KURU_RETIRED_DEPLOYMENT.markets.find((m) => m.symbol === symbol)!.address;
const oldToken = (symbol: string): Address =>
  KURU_RETIRED_DEPLOYMENT.tokens.find((t) => t.symbol === symbol)!.address;

/** A mandate as an agent hired before SEN-185 stored it: Set-C books and USDC. */
function setCMandate() {
  const mandate = demoMandate();
  return {
    ...mandate,
    kuru: {
      markets: [old('MON-USDC'), old('cbBTC-USDC'), WETH_USDC],
      maxDepositAtoms: { [oldToken('USDC')]: 1_000_000_000n, [MON]: 5n * 10n ** 18n },
    },
    rollingCap: { windowSeconds: 86_400, capAtoms: 2_000_000_000n, token: oldToken('USDC') },
  };
}

test('a current mandate names nothing retired', () => {
  assert.deepEqual(retiredKuruReferences(demoMandate()), []);
  assert.equal(retiredKuruMessage([]), '');
  assert.deepEqual(withCurrentKuru(demoMandate()), demoMandate());
});

test('every retired book and token is named, with its successor', () => {
  const refs = retiredKuruReferences(setCMandate());
  assert.deepEqual(
    refs.map((r) => [r.kind, r.fromSymbol, r.toSymbol]),
    [
      ['market', 'MON-USDC', 'MON-USDC'],
      ['market', 'cbBTC-USDC', 'WBTC-USDC'],
      ['token', 'USDC', 'USDC'],
    ],
  );
  assert.equal(
    retiredKuruMessage(refs),
    "This agent's mandate names markets Kuru retired — amend it to move to the new markets " +
      '(MON-USDC, cbBTC-USDC → WBTC-USDC). Until then it cannot trade on Kuru.',
  );
});

test('withCurrentKuru carries every retired entry to its successor, caps and all', () => {
  const moved = withCurrentKuru(setCMandate());
  assert.deepEqual(moved.kuru.markets, [MON_USDC, WBTC_USDC, WETH_USDC]);
  assert.deepEqual(moved.kuru.maxDepositAtoms, {
    [MON]: 5n * 10n ** 18n,
    [USDC]: 1_000_000_000n,
  });
  assert.equal(moved.rollingCap?.token, USDC);
  assert.deepEqual(retiredKuruReferences(moved), []);
  // And it now parses and compiles against the current deployment.
  const json = JSON.parse(
    JSON.stringify(moved, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
  assert.deepEqual(parseMandate(json).kuru.markets, moved.kuru.markets);
  assert.ok(compileMandate(moved).length > 0);
});

test("a successor's own cap wins over the retired token's, and a book is listed once", () => {
  const both = {
    ...demoMandate(),
    kuru: {
      markets: [old('MON-USDC'), MON_USDC],
      maxDepositAtoms: { [oldToken('USDC')]: 9n, [getAddress(USDC)]: 7n },
    },
  };
  const moved = withCurrentKuru(both);
  assert.deepEqual(moved.kuru.markets, [MON_USDC]);
  assert.deepEqual(moved.kuru.maxDepositAtoms, { [USDC]: 7n });
});

test('parseMandate refuses a retired book or token by name, pointing at its successor', () => {
  const input = (kuru: unknown) => ({
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru'],
    kuru,
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '1',
  });
  assert.throws(
    () => parseMandate(input({ markets: [old('cbBTC-USDC')], maxDepositAtoms: {} })),
    (e: unknown) =>
      e instanceof MandateError &&
      /cbBTC-USDC book Kuru retired on 2026-09-25; name WBTC-USDC/.test(e.reason),
  );
  assert.throws(
    () => parseMandate(input({ markets: [], maxDepositAtoms: { [oldToken('XAUt')]: '1' } })),
    (e: unknown) =>
      e instanceof MandateError &&
      e.reason.includes(`name XAUT (${KURU_TESTNET_TOKENS.XAUT.address})`),
  );
});
