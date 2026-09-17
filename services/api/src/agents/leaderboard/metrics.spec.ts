/**
 * The metric math (SEN-26), pinned.
 *
 * These are the definitions the screen publishes, so they are tested as
 * definitions: what `n` counts, what the win rate divides by, what counts as
 * capital, and that a rate over nothing is `null` rather than `0`.
 */
import type { IndexerAccount, IndexerAccountBalance } from './indexer';
import {
  CAPITAL_DECIMALS,
  FORMULA,
  MIN_RANKED_TRADES,
  compareRows,
  isRankable,
  metricsOf,
} from './metrics';

const USDC = '0xee0722ead54f1b4fe97be399be43bc0226a6f97e';
const MON = '0x0000000000000000000000000000000000000000';

/** A stablecoin custody row: a 6dp token, deposited or withdrawn. */
function stable(net: string, over: Partial<IndexerAccountBalance> = {}): IndexerAccountBalance {
  return { token: USDC, decimals: CAPITAL_DECIMALS, deposited: net, withdrawn: '0', net, ...over };
}

function account(over: Partial<IndexerAccount> = {}): IndexerAccount {
  return {
    id: 'kuru-62',
    venue: 'KURU',
    address: '0x1111111111111111111111111111111111111111',
    totalTradeCount: 0,
    totalVolumeUsd: '0',
    realizedPnlUsd: '0',
    winningTradeCount: 0,
    losingTradeCount: 0,
    balances: [],
    ...over,
  };
}

describe('metricsOf', () => {
  it('counts settled trades as wins + losses, summed over every venue account', () => {
    const metrics = metricsOf([
      account({ winningTradeCount: 4, losingTradeCount: 2, totalTradeCount: 19 }),
      account({
        id: 'perpl-1',
        venue: 'PERPL',
        winningTradeCount: 1,
        losingTradeCount: 3,
        totalTradeCount: 11,
      }),
    ]);

    expect(metrics).toMatchObject({ n: 10, wins: 5, losses: 5, fills: 30 });
  });

  it('gives no win rate over nothing: 0/0 is null, not a perfect record', () => {
    const metrics = metricsOf([account({ totalTradeCount: 7 })]);

    expect(metrics).toMatchObject({ n: 0, fills: 7, winRate: null, roi: null });
  });

  it('rounds the win rate at 4dp, half up, decided in integers', () => {
    expect(metricsOf([account({ winningTradeCount: 2, losingTradeCount: 1 })]).winRate).toBe(
      0.6667,
    );
    // 1/32 = 0.03125 exactly — the digit that a float would round either way.
    expect(metricsOf([account({ winningTradeCount: 1, losingTradeCount: 31 })]).winRate).toBe(
      0.0313,
    );
    expect(metricsOf([account({ winningTradeCount: 3, losingTradeCount: 3 })]).winRate).toBe(0.5);
    expect(metricsOf([account({ winningTradeCount: 0, losingTradeCount: 2 })]).winRate).toBe(0);
  });

  it('measures ROI as realised PnL over capital deployed', () => {
    const metrics = metricsOf([account({ realizedPnlUsd: '25', balances: [stable('100')] })]);

    expect(metrics).toMatchObject({
      realisedPnlUsd: '25',
      capitalDeployedUsd: '100',
      roi: 0.25,
    });
  });

  it('counts a loss as a negative ROI', () => {
    const metrics = metricsOf([account({ realizedPnlUsd: '-12.5', balances: [stable('50')] })]);

    expect(metrics.roi).toBe(-0.25);
  });

  it('rounds ROI at 4dp too, half up, and keeps the sign', () => {
    // 1/32 = 0.03125 exactly — the digit a float would round either way.
    expect(metricsOf([account({ realizedPnlUsd: '1', balances: [stable('32')] })]).roi).toBe(
      0.0313,
    );
    expect(metricsOf([account({ realizedPnlUsd: '-1', balances: [stable('32')] })]).roi).toBe(
      -0.0313,
    );
  });

  it('adds decimals exactly, never through a float', () => {
    const metrics = metricsOf([
      account({ realizedPnlUsd: '0.1' }),
      account({ id: 'perpl-1', realizedPnlUsd: '0.2' }),
    ]);

    expect(metrics.realisedPnlUsd).toBe('0.3');
  });

  it('takes capital deployed as the NET stablecoin flow, so a withdrawal is not capital', () => {
    const metrics = metricsOf([
      account({
        balances: [
          stable('120', { deposited: '150', withdrawn: '30', net: '120' }),
          stable('40', { token: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' }),
        ],
        realizedPnlUsd: '32',
      }),
    ]);

    expect(metrics).toMatchObject({ capitalDeployedUsd: '160', roi: 0.2 });
  });

  it('does not count MON as capital: gas is spent, not risked', () => {
    const metrics = metricsOf([
      account({
        realizedPnlUsd: '4',
        balances: [stable('500000000', { token: MON, decimals: 18 })],
      }),
    ]);

    expect(metrics).toMatchObject({ capitalDeployedUsd: '0', roi: null });
  });

  it('does not let a negative net flip the sign of every ROI', () => {
    const metrics = metricsOf([account({ realizedPnlUsd: '3', balances: [stable('-10')] })]);

    expect(metrics).toMatchObject({ capitalDeployedUsd: '0', roi: null });
  });

  it('refuses a decimal it cannot trust rather than reading it as zero', () => {
    expect(() => metricsOf([account({ realizedPnlUsd: 'twelve' })])).toThrow(/not a decimal/);
  });

  it('publishes its definitions, n first', () => {
    expect(FORMULA).toContain('n = settled trades');
    expect(FORMULA).toContain('win rate = wins ÷ n');
    expect(FORMULA).toContain('ROI = realised PnL ÷ capital deployed');
  });
});

describe('the n < 3 rule', () => {
  it('needs MIN_RANKED_TRADES settled trades to be ranked', () => {
    expect(MIN_RANKED_TRADES).toBe(3);
    expect(isRankable({ n: 2, winRate: 1, roi: 9, name: 'two' })).toBe(false);
    expect(isRankable({ n: 3, winRate: 0, roi: -1, name: 'three' })).toBe(true);
  });
});

describe('compareRows', () => {
  const row = (name: string, n: number, winRate: number | null, roi: number | null) => ({
    name,
    n,
    winRate,
    roi,
  });

  it('ranks by ROI first, and a row with no ROI below every row with one', () => {
    const rows = [
      row('no-capital', 9, 0.9, null),
      row('small', 3, 0.1, 0.05),
      row('big', 3, 0.1, 0.4),
    ];

    expect([...rows].sort(compareRows).map((r) => r.name)).toEqual(['big', 'small', 'no-capital']);
  });

  it('breaks an ROI tie on win rate, then on the bigger sample, then on name', () => {
    const rows = [
      row('zebra', 5, 0.5, 0.1),
      row('alpha', 5, 0.5, 0.1),
      row('smaller', 3, 0.5, 0.1),
      row('worse-rate', 9, 0.4, 0.1),
    ];

    expect([...rows].sort(compareRows).map((r) => r.name)).toEqual([
      'alpha',
      'zebra',
      'smaller',
      'worse-rate',
    ]);
  });
});
