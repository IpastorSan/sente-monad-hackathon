/**
 * The address table is hand-copied from deployment docs, and viem refuses a
 * mixed-case address whose EIP-55 checksum is wrong — at call time, deep in an
 * encoder. Catch a bad copy here instead of mid-run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAddress } from 'viem';

import {
  KURU_FAUCET,
  KURU_RETIRED_DEPLOYMENT,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  kuruMarketSuccessor,
  kuruTokenSuccessor,
  type KuruToken,
  NATIVE_TOKEN,
  retiredKuruMarket,
} from './constants.ts';

test('every configured address is a valid, checksummed address', () => {
  const addresses: [string, string][] = [
    ...Object.entries(KURU_TESTNET_CONTRACTS),
    ...Object.values(KURU_TESTNET_TOKENS).map((t): [string, string] => [t.symbol, t.address]),
    ...KURU_TESTNET_MARKETS.map((m): [string, string] => [m.symbol, m.address]),
    ['faucet', KURU_FAUCET.address],
    ...Object.entries(KURU_RETIRED_DEPLOYMENT.contracts),
    ...KURU_RETIRED_DEPLOYMENT.tokens.map((t): [string, string] => [t.symbol, t.address]),
    ...KURU_RETIRED_DEPLOYMENT.markets.map((m): [string, string] => [m.symbol, m.address]),
  ];
  for (const [name, address] of addresses) {
    assert.ok(isAddress(address, { strict: true }), `${name}: ${address}`);
  }
});

test('every market is quoted in Kuru Testnet USDC, not AUSD', () => {
  for (const market of KURU_TESTNET_MARKETS) {
    assert.equal(market.quote, KURU_TESTNET_TOKENS.USDC, market.symbol);
  }
});

test('every retired market and token maps to a current one (SEN-185)', () => {
  for (const old of KURU_RETIRED_DEPLOYMENT.markets) {
    const next = kuruMarketSuccessor(old.address);
    assert.ok(KURU_TESTNET_MARKETS.includes(next), old.symbol);
    assert.equal(retiredKuruMarket(next.address), undefined, `${next.symbol} is not retired`);
  }
  assert.equal(
    kuruMarketSuccessor('0x5bdea6f9f9aba34f4ecb9b865646a792b835ef7f').symbol,
    'WBTC-USDC',
  );
  for (const old of KURU_RETIRED_DEPLOYMENT.tokens) {
    assert.ok(
      (Object.values(KURU_TESTNET_TOKENS) as KuruToken[]).includes(kuruTokenSuccessor(old.address)),
    );
  }
  assert.throws(() => kuruMarketSuccessor(KURU_TESTNET_MARKETS[0]!.address));
});

test('no address is both current and retired', () => {
  const retired = [
    ...Object.values(KURU_RETIRED_DEPLOYMENT.contracts),
    ...KURU_RETIRED_DEPLOYMENT.tokens.map((t) => t.address),
    ...KURU_RETIRED_DEPLOYMENT.markets.map((m) => m.address),
  ].map((a) => a.toLowerCase());
  const current = [
    ...Object.values(KURU_TESTNET_CONTRACTS),
    ...Object.values(KURU_TESTNET_TOKENS).map((t) => t.address),
    ...KURU_TESTNET_MARKETS.map((m) => m.address),
  ]
    .map((a) => a.toLowerCase())
    .filter((a) => a !== NATIVE_TOKEN);
  for (const address of current) assert.ok(!retired.includes(address), address);
});
