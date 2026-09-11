/** The fund call: decoded back, so the test does not trust the encoder it tests. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeFunctionData, erc20Abi, type Address } from 'viem';

import { buildFundCall, FUNDING_TOKENS, isNativeToken } from './fund.ts';
import { KURU_TOKENS } from './mandate.ts';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;

function token(symbol: string) {
  const found = FUNDING_TOKENS.find((t) => t.symbol === symbol);
  if (!found) throw new Error(`no funding token ${symbol}`);
  return found;
}

test('an ERC-20 fund is transfer(agent, atoms) on the token contract, with no value', () => {
  const usdc = token('USDC');
  const call = buildFundCall(usdc, AGENT, 1_000_000n);

  assert.equal(call.to, usdc.address);
  assert.equal(call.value, undefined);
  assert.equal(call.data?.slice(0, 10), '0xa9059cbb', 'transfer(address,uint256)');
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data ?? '0x' });
  assert.equal(decoded.functionName, 'transfer');
  assert.deepEqual(decoded.args, [AGENT, 1_000_000n]);
});

test('AUSD funds through its own contract', () => {
  const call = buildFundCall(token('AUSD'), AGENT, 5n);
  assert.equal(call.to, '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC');
});

test('MON is a native value send straight to the agent', () => {
  const mon = token('MON');
  assert.ok(isNativeToken(mon));
  assert.deepEqual(buildFundCall(mon, AGENT, 10n ** 17n), { to: AGENT, value: 10n ** 17n });
});

test('a zero or negative amount is refused before anything is signed', () => {
  assert.throws(() => buildFundCall(token('USDC'), AGENT, 0n), RangeError);
  assert.throws(() => buildFundCall(token('USDC'), AGENT, -1n), RangeError);
});

test('funding offers USDC, AUSD and MON first, and every Kuru token exactly once', () => {
  const symbols = FUNDING_TOKENS.map((t) => t.symbol);
  assert.deepEqual(symbols.slice(0, 3), ['USDC', 'AUSD', 'MON']);
  for (const kuruToken of KURU_TOKENS) {
    assert.equal(symbols.filter((s) => s === kuruToken.symbol).length, 1, kuruToken.symbol);
  }
});
