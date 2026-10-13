/**
 * Archiving a stopped agent (SEN-197): the client's read of what is left.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fundsLeftOf, perplCollateralOf } from './archive.ts';
import type { AgentPortfolioDto } from './api.ts';

const bal = (asset: string, total: string) => ({
  asset,
  available: total,
  locked: '0',
  total,
  decimals: 6,
});

function portfolio(over: Partial<AgentPortfolioDto> = {}): AgentPortfolioDto {
  return {
    agentId: 'a',
    address: '0x0',
    asOf: 0,
    wallet: { ok: true, balances: [bal('MON', '2'), bal('USDC', '0.001')] },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl: { ok: true, status: 'no_account' },
    holdings: [],
    totals: { approxUsd: '0', byQuote: { USDC: '0', AUSD: '0' }, note: '' },
    ...over,
  };
}

test('an emptied agent has nothing left: gas MON and dust do not count', () => {
  assert.deepEqual(fundsLeftOf(portfolio()), []);
});

test('names what is left in the wallet, on Kuru and on Perpl', () => {
  const left = fundsLeftOf(
    portfolio({
      wallet: { ok: true, balances: [bal('AUSD', '20')] },
      kuru: { ok: true, accountId: '1', balances: [bal('USDC', '3')], openOrders: [] },
    }),
  );
  assert.deepEqual(left, [
    { where: 'wallet', asset: 'AUSD', amount: '20' },
    { where: 'kuru', asset: 'USDC', amount: '3' },
  ]);
});

test('does not guess when the portfolio is missing or a section failed', () => {
  assert.equal(fundsLeftOf(undefined), null);
  assert.equal(fundsLeftOf(portfolio({ kuru: { ok: false, error: 'rpc' } })), null);
});

test('Perpl collateral stays and does not block; an open position does (SEN-203)', () => {
  const perpl = (positions: { symbol: string; size: string }[]) =>
    portfolio({
      perpl: {
        ok: true,
        status: 'ok',
        accountId: '9',
        balances: [bal('AUSD', '100'), bal('USDC', '0.001')],
        positions: positions as never,
        openOrders: [],
      },
    });
  assert.deepEqual(fundsLeftOf(perpl([])), []);
  assert.deepEqual(perplCollateralOf(perpl([])), [
    { where: 'perpl', asset: 'AUSD', amount: '100' },
  ]);
  assert.deepEqual(fundsLeftOf(perpl([{ symbol: 'BTC', size: '0.01' }])), [
    { where: 'perpl', asset: 'BTC', amount: '0.01' },
  ]);
  assert.deepEqual(perplCollateralOf(portfolio()), []);
  assert.deepEqual(perplCollateralOf(undefined), []);
});
