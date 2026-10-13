import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addAmounts,
  amountFigure,
  amountsOf,
  amountsText,
  amountsTone,
  signedAmountsText,
} from './assetAmounts.ts';

test('addAmounts sums each asset exactly and never adds one asset to another', () => {
  const merged = addAmounts(
    [
      { asset: 'AUSD', amount: '20.89' },
      { asset: 'WETH', amount: '0.001' },
    ],
    [
      { asset: 'USDC', amount: '25.5' },
      { asset: 'AUSD', amount: '0.000001' },
      { asset: 'WETH', amount: 'nope' },
    ],
  );
  assert.deepEqual(merged, [
    { asset: 'USDC', amount: '25.5' },
    { asset: 'AUSD', amount: '20.890001' },
    { asset: 'WETH', amount: '0.001' },
  ]);
  assert.deepEqual(amountsOf({ AUSD: '1', USDC: '2' }), [
    { asset: 'USDC', amount: '2' },
    { asset: 'AUSD', amount: '1' },
  ]);
});

test('amountsText lists each non-zero asset, truncated to its places', () => {
  assert.equal(
    amountsText([
      { asset: 'USDC', amount: '25.529' },
      { asset: 'AUSD', amount: '20.89' },
    ]),
    '25.52 USDC · 20.89 AUSD',
  );
  assert.equal(
    amountsText([
      { asset: 'USDC', amount: '0' },
      { asset: 'AUSD', amount: '50' },
    ]),
    '50.00 AUSD',
  );
  assert.equal(amountsText([{ asset: 'WETH', amount: '0.009991' }]), '0.00999 WETH');
  assert.equal(amountsText([{ asset: 'MON', amount: '1234.56789' }]), '1,234.5678 MON');
  assert.equal(amountsText([{ asset: 'USDC', amount: '0' }]), '0.00 USDC');
  assert.equal(amountsText([]), '0.00');
});

test('signedAmountsText signs each asset and drops what rounds to zero', () => {
  assert.equal(
    signedAmountsText([
      { asset: 'USDC', amount: '-0.13' },
      { asset: 'AUSD', amount: '0.955' },
    ]),
    '−0.13 USDC · +0.96 AUSD',
  );
  assert.equal(signedAmountsText([{ asset: 'USDC', amount: '0.001' }]), '0.00 USDC');
  assert.equal(
    signedAmountsText([
      { asset: 'USDC', amount: '0' },
      { asset: 'AUSD', amount: '0' },
    ]),
    '0.00',
  );
});

test('amountsTone is a direction only when every asset agrees', () => {
  assert.equal(amountsTone([{ asset: 'USDC', amount: '1' }]), 'up');
  assert.equal(
    amountsTone([
      { asset: 'USDC', amount: '-1' },
      { asset: 'AUSD', amount: '0' },
    ]),
    'down',
  );
  assert.equal(
    amountsTone([
      { asset: 'USDC', amount: '-1' },
      { asset: 'AUSD', amount: '1' },
    ]),
    null,
  );
});

test('amountFigure never rounds a holding up', () => {
  assert.equal(amountFigure('349.996', 'AUSD'), '349.99');
  assert.equal(amountFigure('-0.004', 'AUSD'), '0.00');
});
