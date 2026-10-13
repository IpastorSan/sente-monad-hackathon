/**
 * What a return said it did (SEN-203): only what arrived is "sent", and any
 * reverted leg, the Kuru withdraw included, is an error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReturnedAsset, ReturnFundsResult } from './api.ts';
import { describeReturn } from './returnOutcome.ts';

const leg = (amount: string, success: boolean) => ({ amount, transactionHash: '0x1', success });

function result(assets: ReturnedAsset[]): ReturnFundsResult {
  return {
    agentId: 'a',
    returnTo: '0x0000000000000000000000000000000000000001',
    assets,
    monSpent: '0.01',
  };
}

test('a landed transfer beside a reverted Kuru withdraw is not a clean "Sent"', () => {
  const notice = describeReturn(
    result([{ asset: 'USDC', withdrawn: leg('10', false), returned: leg('5', true) }]),
    false,
  );
  assert.equal(notice.tone, 'error');
  assert.match(notice.detail ?? '', /USDC \(Kuru withdraw\) reverted/);
  assert.match(notice.detail ?? '', /5 USDC did/);
});

test('a reverted transfer is an error naming what did move', () => {
  const notice = describeReturn(
    result([
      { asset: 'USDC', returned: leg('5', true) },
      { asset: 'AUSD', returned: leg('3', false) },
    ]),
    false,
  );
  assert.equal(notice.tone, 'error');
  assert.equal(
    notice.detail,
    'AUSD reverted on chain, so that part didn’t move. 5 USDC did. Try again.',
  );
});

test('a withdraw that pays the owner directly counts as sent (Set D)', () => {
  const notice = describeReturn(
    result([{ asset: 'USDC', withdrawn: leg('10', true), returned: leg('2.5', true) }]),
    true,
  );
  assert.equal(notice.tone, 'ok');
  assert.equal(notice.title, 'Sent 12.5 USDC back to your wallet');
});

test('a withdraw to the agent itself is counted once, by the transfer (Set C)', () => {
  const notice = describeReturn(
    result([{ asset: 'USDC', withdrawn: leg('10', true), returned: leg('10', true) }]),
    false,
  );
  assert.equal(notice.title, 'Sent 10 USDC back to your wallet');
});

test('nothing to send is information, not an error', () => {
  const notice = describeReturn(result([{ asset: 'USDC', skipped: 'none' }]), true);
  assert.equal(notice.tone, 'info');
});
