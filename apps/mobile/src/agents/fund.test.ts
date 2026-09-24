/**
 * The funding token list, and the one branch a send takes on it.
 *
 * What a fund transfer LOOKS like on the wire moved to `wallet/send.test.ts`
 * with the send itself (SEN-42); it is asserted there against the payload the
 * device key signs, which is the only place the encoding matters.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FUNDING_TOKENS, isNativeToken } from './fund.ts';
import { AUSD, KURU_TOKENS } from './mandate.ts';

function token(symbol: string) {
  const found = FUNDING_TOKENS.find((t) => t.symbol === symbol);
  if (!found) throw new Error(`no funding token ${symbol}`);
  return found;
}

test('funding offers USDC, AUSD and MON first, and every Kuru token exactly once', () => {
  const symbols = FUNDING_TOKENS.map((t) => t.symbol);
  assert.deepEqual(symbols.slice(0, 3), ['USDC', 'AUSD', 'MON']);
  for (const kuruToken of KURU_TOKENS) {
    assert.equal(symbols.filter((s) => s === kuruToken.symbol).length, 1, kuruToken.symbol);
  }
});

test('AUSD is Perpl’s collateral contract, not Kuru’s USDC', () => {
  assert.equal(token('AUSD').address, AUSD.address);
  assert.notEqual(token('AUSD').address, token('USDC').address);
});

test('only MON is native: everything else moves as an ERC-20 transfer', () => {
  assert.ok(isNativeToken(token('MON')));
  for (const other of FUNDING_TOKENS.filter((t) => t.symbol !== 'MON')) {
    assert.equal(isNativeToken(other), false, other.symbol);
  }
});
