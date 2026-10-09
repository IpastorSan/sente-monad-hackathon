/**
 * Funding at hire (SEN-177): which tokens are offered, how the amount is
 * checked, and the order — hire first, fund second, and a failed funding
 * never takes the hire with it. Fakes only: nothing here sends anything.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from 'viem';

import { SendApprovalRefusedError, type SentTransfer } from '../wallet/send.ts';
import type { HireAgentResult } from './api.ts';
import {
  checkFunding,
  fundAgent,
  fundingOutcome,
  fundingTokensFor,
  hireThenFund,
  type FundingState,
} from './initialFunding.ts';
import {
  AUSD,
  buildMandate,
  defaultMandateForm,
  KURU_TOKENS,
  type MandateForm,
} from './mandate.ts';

const NOW = 1_789_000_000;
const AGENT: Address = '0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE';
const USDC = KURU_TOKENS.find((token) => token.symbol === 'USDC');
if (!USDC) throw new Error('no USDC');

function mandate(patch: Partial<MandateForm> = {}) {
  const result = buildMandate({ ...defaultMandateForm(NOW), ...patch }, NOW);
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.mandate;
}

function hired(): HireAgentResult {
  return {
    agent: { id: 'a-1', name: 'Night desk', address: AGENT } as HireAgentResult['agent'],
    mcpToken: 't',
  };
}

const sent = (patch: Partial<SentTransfer>): SentTransfer => ({
  status: 'pending',
  sponsored: true,
  ...patch,
});

test('only the tokens the mandate can put to work are offered', () => {
  assert.deepEqual(
    fundingTokensFor(mandate()).map((t) => t.symbol),
    ['USDC'],
  );
  assert.deepEqual(
    fundingTokensFor(
      mandate({
        perpl: true,
        perplCollateral: '100',
        perplMarkets: 'BTC-PERP',
        depositCaps: { USDC: '100', MON: '5' },
      }),
    ).map((t) => t.symbol),
    // MON has a deposit cap but is gas, and gas is dripped: not offered.
    ['USDC', 'AUSD'],
  );
  assert.deepEqual(
    fundingTokensFor(
      mandate({ kuru: false, perpl: true, perplCollateral: '100', perplMarkets: 'BTC-PERP' }),
    ),
    [AUSD],
  );
});

test('the amount is checked against the account, and empty means later', () => {
  assert.deepEqual(checkFunding('', USDC, 10_000_000n), { kind: 'skip' });
  assert.deepEqual(checkFunding('0', USDC, 10_000_000n), { kind: 'skip' });
  assert.deepEqual(checkFunding('2.5', USDC, 10_000_000n), { kind: 'ok', atoms: 2_500_000n });
  assert.deepEqual(checkFunding('10', USDC, 10_000_000n), { kind: 'ok', atoms: 10_000_000n });
  const over = checkFunding('10.01', USDC, 10_000_000n);
  assert.equal(over.kind, 'invalid');
  assert.match(
    over.kind === 'invalid' ? over.error : '',
    /More than your account holds \(10 USDC\)/,
  );
  assert.equal(checkFunding('1.0000001', USDC, 10_000_000n).kind, 'invalid');
  assert.equal(checkFunding('abc', USDC, null).kind, 'invalid');
  // Balance still loading: the format decides, the send has the last word.
  assert.deepEqual(checkFunding('5', USDC, null), { kind: 'ok', atoms: 5_000_000n });
});

test('a send settles into one outcome, and a revert is not a success', () => {
  const tx = `0x${'ab'.repeat(32)}` as const;
  const op = `0x${'cd'.repeat(32)}` as const;
  assert.deepEqual(
    fundingOutcome(
      sent({
        userOpHash: op,
        confirmation: { userOpHash: op, status: 'included', transactionHash: tx, source: 'api' },
      }),
      '25 USDC',
    ),
    { kind: 'sent', label: '25 USDC', transactionHash: tx },
  );
  assert.equal(
    fundingOutcome(
      sent({ confirmation: { userOpHash: op, status: 'reverted', source: 'api' } }),
      '25 USDC',
    ).kind,
    'failed',
  );
  assert.deepEqual(
    fundingOutcome(
      sent({ confirmation: { userOpHash: op, status: 'pending', source: 'timeout' } }),
      '25 USDC',
    ),
    { kind: 'submitted', label: '25 USDC', status: 'pending' },
  );
});

test('fundAgent sends exactly the intent, and turns a throw into a failed outcome', async () => {
  const seen: unknown[] = [];
  const ok = await fundAgent(
    async (intent) => {
      seen.push(intent);
      return sent({ status: 'pending' });
    },
    { walletId: 'w', token: USDC, to: AGENT, atoms: 25_000_000n },
  );
  assert.deepEqual(seen, [{ walletId: 'w', token: USDC, to: AGENT, atoms: 25_000_000n }]);
  assert.equal(ok.kind, 'submitted');

  const refused = await fundAgent(
    () => Promise.reject(new SendApprovalRefusedError('the recipient changed')),
    { walletId: 'w', token: USDC, to: AGENT, atoms: 25_000_000n },
  );
  assert.equal(refused.kind, 'failed');
  assert.equal(refused.kind === 'failed' ? refused.title : '', 'This phone refused to sign it');
});

test('hire comes first, funding goes to the hired wallet, then reports', async () => {
  const order: string[] = [];
  const states: FundingState[] = [];
  await hireThenFund({
    hire: async () => {
      order.push('hire');
      return hired();
    },
    funding: { token: USDC, atoms: 25_000_000n },
    fund: async (to, token, atoms) => {
      order.push(`fund ${to} ${token.symbol} ${atoms}`);
      return { kind: 'sent', label: '25 USDC' };
    },
    onHired: () => order.push('hired'),
    onFunding: (state) => states.push(state),
  });
  assert.deepEqual(order, ['hire', 'hired', `fund ${AGENT} USDC 25000000`]);
  assert.deepEqual(states, [
    { kind: 'funding', label: '25 USDC' },
    { kind: 'sent', label: '25 USDC' },
  ]);
});

test('a failed funding leaves the hire standing', async () => {
  let hiredResult: HireAgentResult | null = null;
  const states: FundingState[] = [];
  await hireThenFund({
    hire: async () => hired(),
    funding: { token: USDC, atoms: 25_000_000n },
    fund: () => Promise.reject(new Error('network down')),
    onHired: (result) => (hiredResult = result),
    onFunding: (state) => states.push(state),
  });
  assert.ok(hiredResult);
  assert.equal(states.at(-1)?.kind, 'failed');
});

test('no funding asked: hire only, and no funding state at all', async () => {
  let funded = false;
  const states: FundingState[] = [];
  await hireThenFund({
    hire: async () => hired(),
    funding: null,
    fund: async () => {
      funded = true;
      return { kind: 'sent', label: '' };
    },
    onHired: () => undefined,
    onFunding: (state) => states.push(state),
  });
  assert.equal(funded, false);
  assert.deepEqual(states, []);
});

test('a failed hire throws as before and never funds', async () => {
  let funded = false;
  await assert.rejects(
    hireThenFund({
      hire: () => Promise.reject(new Error('mandate_invalid')),
      funding: { token: USDC, atoms: 1n },
      fund: async () => {
        funded = true;
        return { kind: 'sent', label: '' };
      },
      onHired: () => assert.fail('not hired'),
      onFunding: () => assert.fail('no funding'),
    }),
    /mandate_invalid/,
  );
  assert.equal(funded, false);
});
