/** The build's Sente fee pin (SEN-184). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  feePpsToPercent,
  KURU_BUILDER_PIN,
  kuruBuilderAgrees,
  parseKuruBuilderPin,
  senteFeeEstimateAtoms,
  senteFeeOf,
} from './kuruBuilder.ts';

const TREASURY = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8';

test('the pin defaults the rate to 10 bps and checksums the address', () => {
  assert.deepEqual(parseKuruBuilderPin(TREASURY.toLowerCase(), undefined), {
    address: TREASURY,
    feePps: 10_000,
  });
  assert.deepEqual(parseKuruBuilderPin(TREASURY, '5000'), { address: TREASURY, feePps: 5000 });
});

test('a missing or broken pin is no pin: every builder leg is refused', () => {
  for (const [address, pps] of [
    [undefined, '10000'],
    ['', undefined],
    ['0x1234', undefined],
    ['0x0000000000000000000000000000000000000000', undefined],
    [TREASURY, '10001'],
    [TREASURY, '0'],
    [TREASURY, '1.5'],
    [TREASURY, 'ten'],
  ] as const) {
    assert.equal(parseKuruBuilderPin(address, pps), null, `${address} ${pps}`);
  }
});

test('a test build carries no pin (the env is unset under node --test)', () => {
  assert.equal(KURU_BUILDER_PIN, null);
});

test('server and pin agree only on the same builder at the same rate, or both off', () => {
  const pin = { address: TREASURY, feePps: 10_000 } as const;
  assert.equal(kuruBuilderAgrees(pin, pin), true);
  assert.equal(kuruBuilderAgrees({ ...pin, address: TREASURY.toLowerCase() }, pin), true);
  assert.equal(kuruBuilderAgrees(null, null), true);
  assert.equal(kuruBuilderAgrees(undefined, null), true);
  assert.equal(kuruBuilderAgrees(pin, null), false);
  assert.equal(kuruBuilderAgrees(null, pin), false);
  assert.equal(kuruBuilderAgrees({ ...pin, feePps: 9_999 }, pin), false);
  assert.equal(
    kuruBuilderAgrees({ ...pin, address: '0x1111111111111111111111111111111111111111' }, pin),
    false,
  );
  assert.equal(kuruBuilderAgrees({ ...pin, address: 'not an address' }, pin), false);
});

test('the ticket’s estimate: 0.10% of 20 USDC is 0.02 USDC, rounded up', () => {
  const pin = { address: TREASURY, feePps: 10_000 } as const;
  assert.equal(senteFeeEstimateAtoms(20_000_000n, pin), 20_000n);
  assert.equal(senteFeeEstimateAtoms(1_001n, pin), 2n);
  assert.equal(feePpsToPercent(10_000), '0.1');
});

test('senteFeeOf reads the planner’s summary keys, or nothing', () => {
  assert.deepEqual(
    senteFeeOf({
      market: 'MON-USDC',
      senteFeeBps: '10',
      senteFeePps: '10000',
      senteFee: '0.02',
      senteFeeAsset: 'USDC',
    }),
    { bps: '10', pps: '10000', estimate: '0.02', asset: 'USDC' },
  );
  assert.equal(senteFeeOf({ market: 'MON-USDC' }), null);
});
