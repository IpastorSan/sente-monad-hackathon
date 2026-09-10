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
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from './constants.ts';

test('every configured address is a valid, checksummed address', () => {
  const addresses: [string, string][] = [
    ...Object.entries(KURU_TESTNET_CONTRACTS),
    ...Object.values(KURU_TESTNET_TOKENS).map((t): [string, string] => [t.symbol, t.address]),
    ...KURU_TESTNET_MARKETS.map((m): [string, string] => [m.symbol, m.address]),
    ['faucet', KURU_FAUCET.address],
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
