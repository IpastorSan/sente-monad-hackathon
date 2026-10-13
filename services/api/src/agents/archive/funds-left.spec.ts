import type { AgentPortfolioDto, BalanceDto } from '../../venues/dto/markets.dto';
import { describeFundsLeft, fundsLeft } from './funds-left';

function balance(asset: string, total: string): BalanceDto & { decimals: number } {
  return { asset, available: total, locked: '0', total, decimals: 6 };
}

function portfolio(over: Partial<AgentPortfolioDto> = {}): AgentPortfolioDto {
  return {
    agentId: 'a',
    address: '0x0',
    asOf: 0,
    wallet: { ok: true, balances: [balance('MON', '0.4'), balance('USDC', '0')] },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl: { ok: true, status: 'not_in_mandate' },
    holdings: [],
    totals: { approxUsd: '0', byQuote: { USDC: '0', AUSD: '0' }, note: '' },
    ...over,
  };
}

describe('fundsLeft (SEN-197)', () => {
  it('counts nothing for an emptied agent: gas MON and dust are not funds', () => {
    const dust = portfolio({
      wallet: { ok: true, balances: [balance('MON', '3'), balance('USDC', '0.004')] },
    });
    expect(fundsLeft(dust)).toEqual({ left: [], unreadable: [] });
  });

  it('names every balance above dust and every open Perpl position', () => {
    const check = fundsLeft(
      portfolio({
        wallet: { ok: true, balances: [balance('AUSD', '20')] },
        kuru: { ok: true, accountId: '7', balances: [balance('USDC', '1.5')], openOrders: [] },
        perpl: {
          ok: true,
          status: 'ok',
          accountId: '9',
          balances: [balance('AUSD', '0.001')],
          positions: [{ symbol: 'BTC', size: '0.01' } as never],
          openOrders: [],
        },
      }),
    );
    expect(check.left).toEqual([
      { where: 'wallet', asset: 'AUSD', amount: '20' },
      { where: 'kuru', asset: 'USDC', amount: '1.5' },
      { where: 'perpl', asset: 'BTC', amount: '0.01' },
    ]);
    expect(describeFundsLeft(check.left)).toBe(
      '20 AUSD in the wallet, 1.5 USDC in Kuru, 0.01 BTC in Perpl',
    );
  });

  it('lets Perpl collateral stay, but not an open Perpl position (SEN-203)', () => {
    const perpl = (positions: never[]) =>
      portfolio({
        perpl: {
          ok: true,
          status: 'ok',
          accountId: '9',
          balances: [balance('AUSD', '100')],
          positions,
          openOrders: [],
        },
      });
    expect(fundsLeft(perpl([]))).toEqual({ left: [], unreadable: [] });
    expect(fundsLeft(perpl([{ symbol: 'BTC', size: '0.01' } as never])).left).toEqual([
      { where: 'perpl', asset: 'BTC', amount: '0.01' },
    ]);
  });

  it('reports a section it could not read', () => {
    const check = fundsLeft(
      portfolio({ kuru: { ok: false, error: 'rpc' }, perpl: { ok: false, error: 'socket' } }),
    );
    expect(check.unreadable).toEqual(['kuru', 'perpl']);
  });
});
