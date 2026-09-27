import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Balance, Order } from '@sente/venues';
import { getAddress } from 'viem';

import type { KuruAccountVenue, PerplAccountVenue } from '../agents/portfolio/venue-reads';
import type { Principal } from '../auth/principal';
import { TradingEnabledGuard } from '../trade/trade.controller';
import { TradeStore, type Trade } from '../trade/trade-store';
import type { TokenBalance } from '../wallet/balances/token-balances';
import type { UserWalletBinding } from '../wallet/store/user-wallet-registry';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { PortfolioController } from './portfolio.controller';
import { PortfolioModule } from './portfolio.module';
import { UserPortfolioService, type UserPortfolioReaders } from './portfolio.service';

const ADDRESS = getAddress('0x5555555555555555555555555555555555555555');
const ALICE = { userId: 'alice' } as Principal;
const BINDING = { userId: 'alice', walletId: 'w-1', address: ADDRESS } as UserWalletBinding;
const NOW = 1_800_000_000_000;

function token(symbol: string, raw: bigint, amount: string, decimals = 18): TokenBalance {
  return { symbol, address: ADDRESS, decimals, raw, amount };
}

const ORDER: Order = {
  id: '3:9',
  symbol: 'MON-USDC',
  side: 'buy',
  type: 'limit',
  status: 'open',
  price: '3.5',
  size: '10',
  filledSize: '0',
  createdAt: 1,
  updatedAt: 1,
};

function kuru(accountId: bigint, balances: Balance[] = [], orders: Order[] = []) {
  const venue: KuruAccountVenue = {
    accountId: () => Promise.resolve(accountId),
    getBalances: jest.fn(() => Promise.resolve(balances)),
    getOpenOrders: jest.fn(() => Promise.resolve(orders)),
  };
  return venue;
}

function harness(overrides: Partial<UserPortfolioReaders> = {}) {
  const store = new TradeStore();
  const readers: UserPortfolioReaders = {
    registry: { find: (userId) => Promise.resolve(userId === 'alice' ? BINDING : undefined) },
    wallet: { balances: () => Promise.resolve([token('MON', 2n * 10n ** 18n, '2')]) },
    kuruVenue: () => kuru(0n),
    perplAccountInfo: () => Promise.resolve(null),
    perplReadVenue: () => Promise.resolve(undefined),
    trades: store,
    now: () => NOW,
    ...overrides,
  };
  return { service: new UserPortfolioService(readers), store };
}

describe('UserPortfolioService.portfolio', () => {
  it('reads an empty Kuru account (id 0) and no Perpl account', async () => {
    const venue = kuru(0n);
    const { service } = harness({ kuruVenue: () => venue });
    expect(await service.portfolio(ALICE)).toEqual({
      asOf: NOW,
      wallet: {
        ok: true,
        balances: [
          {
            symbol: 'MON',
            address: ADDRESS,
            decimals: 18,
            raw: '2000000000000000000',
            amount: '2',
          },
        ],
      },
      kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
      perpl: { ok: true, status: 'not_onboarded' },
    });
    // Id 0 has nothing to list: no Gateway round trip for it.
    expect(venue.getBalances).not.toHaveBeenCalled();
  });

  it('reports mixed balances across wallet, Kuru and an unlinked Perpl account', async () => {
    const reads: string[] = [];
    const { service } = harness({
      wallet: {
        balances: (address) => {
          reads.push(address);
          return Promise.resolve([
            token('MON', 10n ** 17n, '0.1'),
            token('USDC', 12_345_678n, '12.345678', 6),
            token('AUSD', 0n, '0', 6),
          ]);
        },
      },
      kuruVenue: (address) => {
        reads.push(address);
        return kuru(
          42n,
          [
            { asset: 'USDC', available: '5.5', locked: '35', total: '40.5' },
            { asset: 'MON', available: '1.25', locked: '0', total: '1.25' },
          ],
          [ORDER],
        );
      },
      perplAccountInfo: (address) => {
        reads.push(address);
        return Promise.resolve({ accountId: 7n, balance: 150_000_000n, locked: 25_000_000n });
      },
    });

    const portfolio = await service.portfolio(ALICE);

    // Every venue is read at the session's registered wallet, nothing else.
    expect(reads).toEqual([ADDRESS, ADDRESS, ADDRESS]);
    expect(
      portfolio.wallet.ok && portfolio.wallet.balances.map((t) => [t.symbol, t.raw, t.amount]),
    ).toEqual([
      ['MON', '100000000000000000', '0.1'],
      ['USDC', '12345678', '12.345678'],
      ['AUSD', '0', '0'],
    ]);
    expect(portfolio.kuru).toEqual({
      ok: true,
      accountId: '42',
      balances: [
        { asset: 'USDC', available: '5.5', locked: '35', total: '40.5' },
        { asset: 'MON', available: '1.25', locked: '0', total: '1.25' },
      ],
      openOrders: [expect.objectContaining({ venue: 'kuru', id: '3:9', price: '3.5' })],
    });
    // No read key yet (M-T18): the chain's balance, and positions left out as unknown.
    expect(portfolio.perpl).toEqual({
      ok: true,
      status: 'unlinked',
      accountId: '7',
      balances: [{ asset: 'AUSD', available: '125', locked: '25', total: '150' }],
    });
    expect(portfolio.perpl).not.toHaveProperty('positions');
  });

  it('reads Perpl through the read key once one is linked', async () => {
    const venue: PerplAccountVenue = {
      getBalances: () =>
        Promise.resolve([{ asset: 'AUSD', available: '90', locked: '10', total: '100' }]),
      getPositions: () => Promise.resolve([]),
      getOpenOrders: () => Promise.resolve([]),
    };
    const { service } = harness({
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
      perplReadVenue: (userId, address) =>
        Promise.resolve(userId === 'alice' && address === ADDRESS ? venue : undefined),
    });
    expect((await service.portfolio(ALICE)).perpl).toEqual({
      ok: true,
      status: 'ok',
      accountId: '7',
      balances: [{ asset: 'AUSD', available: '90', locked: '10', total: '100' }],
      positions: [],
      openOrders: [],
    });
  });

  it('keeps the wallet and Perpl when the Kuru read throws (SEN-123)', async () => {
    const venue = kuru(42n);
    venue.getBalances = () => Promise.reject(new Error('Kuru RPC timed out'));
    const { service } = harness({
      kuruVenue: () => venue,
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 150_000_000n, locked: 0n }),
    });

    const portfolio = await service.portfolio(ALICE);

    expect(portfolio.kuru).toEqual({ ok: false, error: 'Kuru RPC timed out' });
    expect(portfolio.wallet).toMatchObject({ ok: true, balances: [{ symbol: 'MON' }] });
    expect(portfolio.perpl).toMatchObject({ ok: true, status: 'unlinked', accountId: '7' });
  });

  it('isolates a failing wallet and a failing Perpl read too', async () => {
    const { service } = harness({
      wallet: { balances: () => Promise.reject(new Error('balanceOf reverted')) },
      perplReadVenue: () => {
        throw new Error('read key vault unreachable');
      },
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
    });

    expect(await service.portfolio(ALICE)).toEqual({
      asOf: NOW,
      wallet: { ok: false, error: 'balanceOf reverted' },
      kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
      perpl: { ok: false, error: 'read key vault unreachable' },
    });
  });

  it('refuses a user with no registered wallet', async () => {
    const { service } = harness();
    await expect(service.portfolio({ userId: 'bob' } as Principal)).rejects.toMatchObject({
      reason: 'account_not_registered',
    });
    await expect(service.fills({ userId: 'bob' } as Principal)).rejects.toBeInstanceOf(
      WalletRefusedError,
    );
  });
});

describe('UserPortfolioService.fills', () => {
  function trade(id: string, at: number, extra: Partial<Trade> & { summary?: object } = {}) {
    return {
      id,
      userId: 'alice',
      clientTradeId: `c-${id}`,
      intentHash: id,
      kind: 'kuru.place',
      walletId: 'w-1',
      address: ADDRESS,
      steps: [
        {
          index: 0,
          kind: 'place',
          title: 'Buy',
          status: 'included',
          transactionHash: `0x${id.padStart(64, '0')}`,
        },
      ],
      status: 'completed',
      createdAt: new Date(at),
      updatedAt: new Date(at + 1),
      expiresAt: new Date(at + 60_000),
      summary: { market: 'MON-USDC', side: 'buy' },
      ...extra,
    } as unknown as Trade;
  }

  const RESULT = {
    status: 'filled' as const,
    orderId: '3:9',
    requestedSize: '2',
    filledSize: '2',
    avgPrice: '3.55',
    fee: '0.01',
    feeAsset: 'USDC' as const,
    fills: [
      { price: '3.5', size: '1', tradeId: 't1' },
      { price: '3.6', size: '1', tradeId: 't2' },
    ],
  };

  it('lists decoded Kuru fills newest first, skipping trades with no result yet', async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));
    // Executing, or composed before M-T15 records results: no fills, no error.
    store.put(trade('b', NOW - 5_000, { status: 'executing' }), new Date(NOW));
    store.put(
      trade('c', NOW - 1_000, { result: { ...RESULT, fills: [RESULT.fills[0]!] } }),
      new Date(NOW),
    );

    const page = await service.fills(ALICE);
    expect(page.next).toBeNull();
    expect(page.fills.map((f) => [f.tradeId, f.venueTradeId])).toEqual([
      ['c', 't1'],
      ['a', 't1'],
      ['a', 't2'],
    ]);
    expect(page.fills[0]).toEqual({
      venue: 'kuru',
      tradeId: 'c',
      venueTradeId: 't1',
      orderId: '3:9',
      symbol: 'MON-USDC',
      side: 'buy',
      price: '3.5',
      size: '1',
      transactionHash: `0x${'c'.padStart(64, '0')}`,
      timestamp: NOW - 1_000 + 1,
    });
  });

  it('pages with an opaque cursor', async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));
    store.put(trade('c', NOW - 1_000, { result: RESULT }), new Date(NOW));

    const first = await service.fills(ALICE, { limit: 3 });
    expect(first.fills).toHaveLength(3);
    expect(first.next).toBe('3');
    const second = await service.fills(ALICE, { limit: 3, cursor: first.next! });
    expect(second).toEqual({ fills: [expect.objectContaining({ tradeId: 'a' })], next: null });
  });

  it('has no Perpl fills until the read key exists', async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));
    expect(await service.fills(ALICE, { venue: 'perpl' })).toEqual({ fills: [], next: null });
  });
});

describe('the trading flag', () => {
  it('gates both routes with the /trade guard', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, PortfolioController);
    expect(guards).toContain(TradingEnabledGuard);
  });

  it('answers 404 trading_disabled with the flag off', () => {
    const guard = new TradingEnabledGuard({ enabled: false, atomicBatch: false, chainId: 10143 });
    expect(() => guard.canActivate()).toThrow(
      expect.objectContaining({
        status: 404,
        response: expect.objectContaining({ reason: 'trading_disabled' }),
      }),
    );
  });

  it('boots the module', async () => {
    const saved = { ...process.env };
    delete process.env.USER_TRADING;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PortfolioModule] }).compile();
      expect(moduleRef.get(UserPortfolioService)).toBeInstanceOf(UserPortfolioService);
      await moduleRef.close();
    } finally {
      process.env = saved;
    }
  });
});
