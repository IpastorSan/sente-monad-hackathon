/** The shared display rules. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatBalance, isoDate, shortAddress } from './format.ts';
import type { TokenBalance } from '../wallet/api.ts';

function balance(symbol: string, raw: bigint, decimals: number): TokenBalance {
  return {
    symbol,
    address: '0x0000000000000000000000000000000000000000',
    decimals,
    raw,
    amount: 'unused',
  };
}

test('formatBalance shows a stablecoin to 2 places and MON to 4', () => {
  assert.equal(formatBalance(balance('AUSD', 1_204_500_000n, 6)), '1,204.50');
  assert.equal(formatBalance(balance('USDC', 0n, 6)), '0.00');
  assert.equal(formatBalance(balance('MON', 2_500_000_000_000_000_000n, 18)), '2.5000');
});

test('formatBalance truncates, so the figure never overstates the balance', () => {
  assert.equal(formatBalance(balance('AUSD', 9_000n, 6)), '0.00');
  assert.equal(formatBalance(balance('USDC', 1_999_999n, 6)), '1.99');
});

test('formatBalance falls back to 2 places for a token it does not know', () => {
  assert.equal(formatBalance(balance('WETH', 1_500_000n, 6)), '1.50');
});

test('a balance the API did not send is a dash, never a confident 0.00', () => {
  assert.equal(formatBalance(null), '—');
});

test('shortAddress elides the middle and leaves short strings alone', () => {
  assert.equal(shortAddress('0x95206CCBE0735bf436b39226DCaA5DF536FA6d5e'), '0x9520…6d5e');
  assert.equal(shortAddress('0x1234'), '0x1234');
});

test('isoDate takes the date part and is the same on every device', () => {
  assert.equal(isoDate('2026-09-18T11:55:17.869Z'), '2026-09-18');
});
