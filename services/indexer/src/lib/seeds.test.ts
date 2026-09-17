/**
 * Tests for the market tables.
 *
 * These pin the two things a wrong seed silently corrupts: the precision is a
 * power of ten (or `decimalsFromPrecision` returns a meaningless scale) and the
 * Perpl snapshot maps to the right decimals (or every perp notional is off by a
 * factor of ten). Values cross-checked against
 * packages/venues/src/kuru/constants.ts and the live Perpl
 * `GET /api/v1/pub/context` snapshot in src/lib/seeds.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KURU_MARKETS,
  KURU_MARKET_SEEDS,
  PERP_COLLATERAL_DECIMALS,
  PERPL_MARKET_SEEDS,
  PERPL_MARKETS,
  kuruMarketByAddress,
  kuruTokenDecimals,
  perplMarketId,
  perplMarketSeedByPerpId,
  NATIVE_TOKEN,
} from './seeds.ts';
import { decimalsFromPrecision, perplQuoteAtoms } from './stats.ts';

const isPowerOfTen = (n: bigint): boolean => {
  if (n <= 0n) return false;
  let v = n;
  while (v % 10n === 0n && v > 1n) v /= 10n;
  return v === 1n;
};

test('every seeded precision is a power of ten', () => {
  for (const seed of [...KURU_MARKET_SEEDS, ...PERPL_MARKET_SEEDS]) {
    assert.ok(isPowerOfTen(seed.pricePrecision), `${seed.marketId} pricePrecision`);
    assert.ok(isPowerOfTen(seed.sizePrecision), `${seed.marketId} sizePrecision`);
    assert.ok(Number.isInteger(seed.baseDecimals) && seed.baseDecimals >= 0);
    assert.ok(seed.quoteDecimals >= 0);
  }
});

test('decimalsFromPrecision reads the exponent', () => {
  assert.equal(decimalsFromPrecision(1_000_000n), 6);
  assert.equal(decimalsFromPrecision(100_000_000n), 8);
  assert.equal(decimalsFromPrecision(1n), 0); // Perpl MON and PUMP size in whole units
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

test('Perpl seeds map price/size decimals onto the venue-neutral row', () => {
  // BTC is perpId 16, 1 price decimal and 5 size decimals on the live context.
  const btc = perplMarketSeedByPerpId(16n);
  assert.ok(btc);
  assert.equal(btc.marketId, 'perpl-16');
  assert.equal(btc.venue, 'PERPL');
  assert.equal(btc.symbol, 'BTC-PERP');
  assert.equal(btc.base, 'BTC');
  assert.equal(btc.quote, 'AUSD');
  assert.equal(btc.pricePrecision, 10n);
  assert.equal(btc.sizePrecision, 100_000n);
  assert.equal(btc.quoteDecimals, PERP_COLLATERAL_DECIMALS);
  assert.equal(btc.address, undefined); // perps have no token address
  assert.equal(perplMarketSeedByPerpId(999n), undefined);

  // MON sizes in whole units (sizeDecimals 0) — that is a real 10^0 precision,
  // not a missing value.
  const mon = perplMarketSeedByPerpId(64n);
  assert.equal(mon?.sizePrecision, 1n);
  assert.equal(decimalsFromPrecision(mon!.sizePrecision), 0);

  assert.equal(PERPL_MARKET_SEEDS.length, PERPL_MARKETS.length);
  assert.equal(perplMarketId(16n), 'perpl-16');
});

test('the real BTC fill prices to 76810.9 and 0.00588 BTC', () => {
  // tx 0xd58c92ad… block 63311165: entryPricePNS 768109, lotLNS 588.
  const btc = perplMarketSeedByPerpId(16n)!;
  const cns = perplQuoteAtoms(
    768_109n,
    588n,
    decimalsFromPrecision(btc.pricePrecision),
    decimalsFromPrecision(btc.sizePrecision),
    PERP_COLLATERAL_DECIMALS,
  );
  // 76810.9 × 0.00588 = 451.648092 AUSD, exactly: 768109 × 588 = 451648092 and
  // the PNS/LNS scales cancel against the 10^6 collateral scale.
  assert.equal(cns, 451_648_092n);
});
