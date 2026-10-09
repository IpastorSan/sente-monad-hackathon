/**
 * The Credits screen's words and stones (SEN-183).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  autoTopUpLine,
  formatUsd,
  freeTierLine,
  isCreditsReason,
  MAX_STONES,
  paymentLine,
  planCard,
  resetLine,
  runCost,
  runsLabel,
  spentShare,
  stoneRow,
  utcDay,
} from './view.ts';

test('formatUsd keeps sub-cent costs readable and whole dollars short', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(10), '$10');
  assert.equal(formatUsd(8.75), '$8.75');
  assert.equal(formatUsd(0.3), '$0.30');
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(-1.5), '−$1.50');
});

test('the free tier is ten stones, spent from the right', () => {
  assert.deepEqual(stoneRow(10, 10).fills, Array(10).fill(1));
  assert.deepEqual(stoneRow(0, 10).fills, Array(10).fill(0));
  assert.deepEqual(stoneRow(8.75, 10).fills, [1, 1, 1, 1, 1, 1, 1, 1, 0.75, 0]);
  assert.equal(stoneRow(8.75, 10).perStone, 1);
});

test('a big limit still draws at most MAX_STONES, and nonsense draws none', () => {
  const row = stoneRow(50, 100);
  assert.equal(row.fills.length, MAX_STONES);
  assert.equal(row.perStone, 5);
  assert.deepEqual(row.fills.slice(9, 11), [1, 0]);
  assert.deepEqual(stoneRow(5, 0).fills, []);
  assert.deepEqual(stoneRow(-3, 10).fills, Array(10).fill(0));
  assert.deepEqual(stoneRow(30, 10).fills, Array(10).fill(1));
});

test('the reset line names the UTC day and says nothing carries over', () => {
  assert.equal(utcDay('2026-11-01T00:00:00.000Z'), 'Nov 1');
  assert.equal(utcDay('nonsense'), null);
  assert.equal(
    resetLine({
      limitUsd: 10,
      reset: { period: 'monthly', resetsAt: '2026-11-01T00:00:00.000Z', summary: '' },
    }),
    'Refills to $10 on Nov 1 (00:00 UTC). Unused credit doesn’t carry over.',
  );
  assert.equal(
    resetLine({ limitUsd: 10, reset: { period: 'monthly', resetsAt: null, summary: '' } }),
    'Refills to $10 on the 1st of each month. Unused credit doesn’t carry over.',
  );
  assert.equal(
    resetLine({ limitUsd: 10, reset: { period: null, resetsAt: null, summary: '' } }),
    'A one-off allowance — it doesn’t refill.',
  );
});

test('the free tier line says the period only when there is one', () => {
  assert.equal(
    freeTierLine(10, 'monthly'),
    'You’re on the free tier — 10 USD of AI credits on us, every month.',
  );
  assert.equal(freeTierLine(10, null), 'You’re on the free tier — 10 USD of AI credits on us.');
});

test('plan cards, auto top-up and payment copy', () => {
  const custom = { minUsd: 5, maxUsd: 500 };
  assert.deepEqual(planCard({ id: 'pack_20', usd: 20 }, custom), {
    title: '$20',
    detail: 'of model credits',
  });
  assert.deepEqual(planCard({ id: 'custom', usd: null }, custom), {
    title: 'Custom',
    detail: '$5–$500',
  });
  assert.equal(autoTopUpLine(2, 10), 'When less than $2 is left, add $10.');
  assert.equal(paymentLine(['USDC', 'AUSD']), 'Paid in USDC or AUSD from your wallet.');
  assert.equal(paymentLine(['USDC']), 'Paid in USDC from your wallet.');
  assert.equal(paymentLine([]), '');
});

test('run rows and the share spent', () => {
  assert.equal(runCost(null), 'no cost reported');
  assert.equal(runCost(0.0125), '$0.013');
  assert.equal(runCost(0.1421), '$0.142');
  assert.equal(runCost(0.004), '$0.0040');
  assert.equal(runsLabel(1), '1 run');
  assert.equal(runsLabel(3), '3 runs');
  assert.equal(spentShare({ limitUsd: 10, remainingUsd: 7.5 }), 0.25);
  assert.equal(spentShare({ limitUsd: null, remainingUsd: null }), 0);
});

test('only the out-of-credits reasons link to the Credits screen', () => {
  assert.equal(isCreditsReason('credits_exhausted'), true);
  assert.equal(isCreditsReason('credits_low'), true);
  assert.equal(isCreditsReason('credits_unavailable'), false);
  assert.equal(isCreditsReason('daily_cap'), false);
  assert.equal(isCreditsReason(undefined), false);
});
