/**
 * The onboarding call list, pinned against hand-assembled calldata.
 *
 * Each expected string is selector ‖ 32-byte words, written out by hand from
 * the selectors verified against the deployed Exchange implementation
 * (docs/monad-testnet-assets.md), so this does not merely re-run viem.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OnboardingAmountError, onboardingParams, perplOnboardingCalls } from './onboarding.ts';
import type { PerplContext } from './wire.ts';

const EXCHANGE = '0x1964C32f0bE608E7D29302AFF5E61268E72080cc';
const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';

/** The slice of the live testnet `/pub/context` onboarding reads. */
const CONTEXT = {
  chain: { chain_id: 10143 },
  instances: [
    {
      id: 12,
      address: EXCHANGE.toLowerCase(),
      collateral_token_id: 1,
      min_account_open_amount: '100000000',
      min_deposit_amount: '10000000',
      min_withdraw_amount: '10000',
    },
  ],
  tokens: [
    {
      id: 1,
      address: AUSD.toLowerCase(),
      symbol: 'AUSD',
      name: 'AUSD',
      decimals: 6,
      display_precision: 2,
    },
  ],
  markets: [],
} satisfies PerplContext;

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

test('params come from the live context, checksummed', () => {
  const params = onboardingParams(CONTEXT);
  assert.equal(params.exchange, EXCHANGE);
  assert.equal(params.collateral, AUSD);
  assert.equal(params.collateralDecimals, 6);
  assert.equal(params.minAccountOpenAmount, 100_000_000n);
  assert.equal(params.minDepositAmount, 10_000_000n);
});

test('approve -> createAccount -> allowOrderForwarding(true), exact bytes', () => {
  const [approve, create, forward] = perplOnboardingCalls(onboardingParams(CONTEXT));

  assert.equal(approve.to, AUSD);
  assert.equal(approve.value, 0n);
  // approve(address,uint256) = 0x095ea7b3
  assert.equal(approve.data, `0x095ea7b3${word(EXCHANGE)}${word('5f5e100')}`);

  assert.equal(create.to, EXCHANGE);
  // createAccount(uint256) = 0xcab13915, 100 AUSD = 100_000_000 = 0x5f5e100
  assert.equal(create.data, `0xcab13915${word('5f5e100')}`);

  assert.equal(forward.to, EXCHANGE);
  // allowOrderForwarding(bool) = 0x7962f910 — a bool, true = 1
  assert.equal(forward.data, `0x7962f910${word('1')}`);
});

test('a larger deposit is approved and deposited exactly — never unlimited', () => {
  const [approve, create] = perplOnboardingCalls(onboardingParams(CONTEXT), 250_000_000n);
  assert.ok(approve.data.endsWith(word('ee6b280')));
  assert.equal(create.data, `0xcab13915${word('ee6b280')}`);
});

test('below the venue minimum is refused before anything is signed', () => {
  assert.throws(
    () => perplOnboardingCalls(onboardingParams(CONTEXT), 99_999_999n),
    OnboardingAmountError,
  );
});
