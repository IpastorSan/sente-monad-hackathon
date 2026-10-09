/**
 * Tests for the market tables.
 *
 * These pin the two things a wrong seed silently corrupts: the precision is a
 * power of ten (or `decimalsFromPrecision` returns a meaningless scale) and the
 * book scale is not confused with the token decimals (or every base amount is
 * off by orders of magnitude). Values cross-checked against
 * packages/venues/src/kuru/constants.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KURU_MARKETS,
  KURU_MARKET_SEEDS,
  kuruMarketByAddress,
  kuruTokenDecimals,
  NATIVE_TOKEN,
} from './seeds.ts';
import { decimalsFromPrecision } from './stats.ts';

const isPowerOfTen = (n: bigint): boolean => {
  if (n <= 0n) return false;
  let v = n;
  while (v % 10n === 0n && v > 1n) v /= 10n;
  return v === 1n;
};

test('every seeded precision is a power of ten', () => {
  for (const seed of KURU_MARKET_SEEDS) {
    assert.ok(isPowerOfTen(seed.pricePrecision), `${seed.marketId} pricePrecision`);
    assert.ok(isPowerOfTen(seed.sizePrecision), `${seed.marketId} sizePrecision`);
    assert.ok(Number.isInteger(seed.baseDecimals) && seed.baseDecimals >= 0);
    assert.ok(seed.quoteDecimals >= 0);
  }
});

test('decimalsFromPrecision reads the exponent', () => {
  assert.equal(decimalsFromPrecision(1_000_000n), 6);
  assert.equal(decimalsFromPrecision(100_000_000n), 8);
  assert.equal(decimalsFromPrecision(1n), 0);
  assert.equal(decimalsFromPrecision(100n), 2);
});

test('Kuru seeds carry the book scale, not the token decimals', () => {
  const mon = kuruMarketByAddress('0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61');
  assert.ok(mon);
  assert.equal(mon.symbol, 'MON-USDC');
  // MON is 18-decimal, but the MON-USDC book sizes in 10^8 units. Confusing the
  // two overstates base volume and bought/sold by 10^10.
  assert.equal(mon.baseDecimals, 18);
  assert.equal(decimalsFromPrecision(mon.sizePrecision), 8);
  assert.equal(decimalsFromPrecision(mon.pricePrecision), 6);
  // Case-insensitive: the OrderBook proxy emits lowercased srcAddress.
  assert.ok(kuruMarketByAddress('0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61'));
  assert.equal(kuruMarketByAddress('0x0000000000000000000000000000000000000001'), undefined);
  assert.equal(KURU_MARKET_SEEDS.length, KURU_MARKETS.length);
});

test('Kuru token decimals: native MON is 18 and USDC is 6', () => {
  assert.equal(kuruTokenDecimals(NATIVE_TOKEN), 18);
  assert.equal(kuruTokenDecimals('0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E'), 6);
  // Unknown token falls back to 18 rather than throwing inside a handler.
  assert.equal(kuruTokenDecimals('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), 18);
});
