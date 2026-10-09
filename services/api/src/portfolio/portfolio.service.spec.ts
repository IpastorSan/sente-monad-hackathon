import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Balance, Order, Position } from '@sente/venues';
import type { PerplFillRecord } from '@sente/venues/perpl';
import { getAddress } from 'viem';

import type { KuruAccountVenue } from '../agents/portfolio/venue-reads';
import type { Principal } from '../auth/principal';
import { TradingEnabledGuard } from '../trade/trade.controller';
import { TradeStore, type Trade } from '../trade/trade-store';
import type { TokenBalance } from '../wallet/balances/token-balances';
import type { UserWalletBinding } from '../wallet/store/user-wallet-registry';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { PortfolioController } from './portfolio.controller';
import { PortfolioModule } from './portfolio.module';
import {
  kuruFeeShares,
  USER_PERPL_STALE_MS,
  USER_PERPL_TTL_MS,
  PortfolioRefusedError,
  UserPortfolioService,
  type PerplUserVenue,
  type UserPortfolioReaders,
} from './portfolio.service';

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

const POSITION: Position = {
  symbol: 'BTC-PERP',
  side: 'long',
  size: '0.01',
  entryPrice: '100000',
  markPrice: '101000',
  liquidationPrice: '94000',
  leverage: 10,
  marginMode: 'isolated',
  margin: '100',
  unrealizedPnl: '10',
  realizedPnl: '0',
  fundingPaid: '0.12',
  updatedAt: 5,
};

/** A fake of the user's read-key Perpl venue (SEN-151); records every sign-in. */
function fakePerpl(overrides: Partial<PerplUserVenue> = {}) {
  const venue: PerplUserVenue = {
    getBalances: () =>
      Promise.resolve([{ asset: 'AUSD', available: '90', locked: '110', total: '200' }]),
    getPositions: () => Promise.resolve([POSITION]),
    getOpenOrders: () => Promise.resolve([{ ...ORDER, id: '77', symbol: 'BTC-PERP' }]),
    getFills: () => Promise.resolve({ fills: [], next: null }),
    ...overrides,
  };
  const opened: string[] = [];
  const reader: UserPortfolioReaders['withPerplReadVenue'] = (userId, read) => {
    opened.push(userId);
    return read(userId === 'alice' ? venue : undefined);
  };
  return { venue, opened, reader };
}

function harness(overrides: Partial<UserPortfolioReaders> = {}) {
  const store = new TradeStore();
  const readers: UserPortfolioReaders = {
    registry: { find: (userId) => Promise.resolve(userId === 'alice' ? BINDING : undefined) },
    wallet: { balances: () => Promise.resolve([token('MON', 2n * 10n ** 18n, '2')]) },
    kuruVenue: () => kuru(0n),
    perplAccountInfo: () => Promise.resolve(null),
    withPerplReadVenue: (_userId, read) => read(undefined),
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
      perpl: { ok: true, status: 'not_onboarded', asOf: NOW },
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
      asOf: NOW,
    });
    expect(portfolio.perpl).not.toHaveProperty('positions');
  });

  it('reads Perpl balances, positions and orders through the read key once linked (SEN-151)', async () => {
    const perpl = fakePerpl();
    const { service } = harness({
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
      withPerplReadVenue: perpl.reader,
    });
    expect((await service.portfolio(ALICE)).perpl).toEqual({
      ok: true,
      status: 'ok',
      accountId: '7',
      balances: [{ asset: 'AUSD', available: '90', locked: '110', total: '200' }],
      positions: [
        {
          symbol: 'BTC-PERP',
          side: 'long',
          size: '0.01',
          entryPrice: '100000',
          markPrice: '101000',
          liquidationPriceEst: '94000',
          leverage: 10,
          margin: '100',
          unrealizedPnl: '10',
          realizedPnl: '0',
          fundingPaid: '0.12',
          quote: 'AUSD',
          updatedAt: 5,
        },
      ],
      openOrders: [expect.objectContaining({ venue: 'perpl', id: '77', symbol: 'BTC-PERP' })],
      asOf: NOW,
    });
  });

  it('signs in to Perpl once per 30 s however often the phone polls (SEN-151)', async () => {
    let now = NOW;
    const perpl = fakePerpl();
    const { service } = harness({
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
      withPerplReadVenue: perpl.reader,
      now: () => now,
    });
    // Concurrent polls share the one read in flight.
    const [a, b] = await Promise.all([service.portfolio(ALICE), service.portfolio(ALICE)]);
    expect(perpl.opened).toHaveLength(1);
    now += 10_000;
    const c = await service.portfolio(ALICE);
    expect(perpl.opened).toHaveLength(1);
    // The section says how old it is; the portfolio's own asOf moves on.
    for (const read of [a, b, c]) expect(read.perpl).toMatchObject({ status: 'ok', asOf: NOW });
    expect(c.asOf).toBe(NOW + 10_000);
    now = NOW + USER_PERPL_TTL_MS;
    await service.portfolio(ALICE);
    expect(perpl.opened).toHaveLength(2);
  });

  it('does not ration an unlinked account: a key linked later shows on the next poll', async () => {
    let linked = false;
    const perpl = fakePerpl();
    const { service } = harness({
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
      withPerplReadVenue: (userId, read) => (linked ? perpl.reader(userId, read) : read(undefined)),
    });
    expect((await service.portfolio(ALICE)).perpl).toMatchObject({ status: 'unlinked' });
    linked = true;
    expect((await service.portfolio(ALICE)).perpl).toMatchObject({ status: 'ok' });
  });

  it('a Perpl failure is a failed section, or the last good read flagged stale (SEN-151)', async () => {
    let now = NOW;
    let failing = false;
    const perpl = fakePerpl({
      getPositions: () =>
        failing ? Promise.reject(new Error('Perpl 429')) : Promise.resolve([POSITION]),
    });
    const { service } = harness({
      perplAccountInfo: () => Promise.resolve({ accountId: 7n, balance: 1n, locked: 0n }),
      withPerplReadVenue: perpl.reader,
      now: () => now,
    });

    await service.portfolio(ALICE);
    failing = true;
    now += USER_PERPL_TTL_MS;
    const stale = await service.portfolio(ALICE);
    expect(stale.perpl).toMatchObject({ ok: true, status: 'ok', asOf: NOW, stale: true });
    expect(stale.wallet.ok && stale.kuru.ok).toBe(true);

    now = NOW + USER_PERPL_STALE_MS + USER_PERPL_TTL_MS;
    const failed = await service.portfolio(ALICE);
    expect(failed.perpl).toEqual({ ok: false, error: 'Perpl 429' });
    expect(failed.wallet).toMatchObject({ ok: true });
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
      withPerplReadVenue: () => Promise.reject(new Error('read key vault unreachable')),
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
      // A single-fill result carries the whole fee (SEN-162).
      fee: '0.01',
      feeAsset: 'USDC',
      transactionHash: `0x${'c'.padStart(64, '0')}`,
      timestamp: NOW - 1_000 + 1,
    });
  });

  it("splits a Kuru result's fee across its fills by notional, summing exactly (SEN-162)", async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));

    const page = await service.fills(ALICE);
    // 0.01 × 3.5/7.1 = 0.0049295… floors to 0.004929 USDC; the last fill takes the rest.
    expect(page.fills.map((f) => [f.venueTradeId, f.fee, f.feeAsset])).toEqual([
      ['t1', '0.004929', 'USDC'],
      ['t2', '0.005071', 'USDC'],
    ]);
  });

  it('kuruFeeShares: exact at the atom, whatever the split (SEN-162)', () => {
    const fills = [
      { price: '1', size: '1' },
      { price: '1', size: '1' },
      { price: '1', size: '1' },
    ];
    expect(kuruFeeShares('0.000001', fills, 6)).toEqual(['0', '0', '0.000001']);
    expect(kuruFeeShares('0.1', fills, 6)).toEqual(['0.033333', '0.033333', '0.033334']);
    expect(kuruFeeShares('0', fills, 6)).toEqual(['0', '0', '0']);
    expect(kuruFeeShares('0.5', [], 6)).toEqual([]);
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

  it('refuses a cursor that is not a Kuru offset', async () => {
    const { service } = harness();
    await expect(service.fills(ALICE, { cursor: 'abc' })).rejects.toMatchObject({
      reason: 'invalid_cursor',
    });
  });

  it('scopes to one market before paging (SEN-157)', async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));
    store.put(
      trade('c', NOW - 1_000, { result: RESULT, summary: { market: 'ETH-USDC', side: 'sell' } }),
      new Date(NOW),
    );

    const page = await service.fills(ALICE, { symbol: 'MON-USDC', limit: 2 });
    expect(page).toEqual({
      fills: [
        expect.objectContaining({ tradeId: 'a', venueTradeId: 't1' }),
        expect.objectContaining({ tradeId: 'a', venueTradeId: 't2' }),
      ],
      next: null,
    });
  });

  it('refuses Perpl fills without a read key rather than answer "none" (SEN-151)', async () => {
    const { service, store } = harness();
    store.put(trade('a', NOW - 10_000, { result: RESULT }), new Date(NOW));
    await expect(service.fills(ALICE, { venue: 'perpl' })).rejects.toMatchObject({
      reason: 'perpl_unlinked',
    });
  });

  const PERPL_FILL: PerplFillRecord = {
    orderId: '42',
    tradeId: `0x${'cd'.repeat(32)}:4`,
    symbol: 'BTC-PERP',
    side: 'sell',
    price: '77108.1',
    size: '0.0025',
    fee: '0.01',
    feeAsset: 'AUSD',
    maker: true,
    timestamp: NOW - 5_000,
    blockNumber: 9_999,
    txHash: `0x${'cd'.repeat(32)}`,
  };

  it("reads Perpl fills with the read key, passing Perpl's cursor through (SEN-151)", async () => {
    let now = NOW;
    const getFills = jest.fn((options: { count?: number; page?: string } = {}) =>
      Promise.resolve(
        options.page ? { fills: [], next: null } : { fills: [PERPL_FILL], next: 'np-1' },
      ),
    );
    const perpl = fakePerpl({ getFills });
    const { service } = harness({ withPerplReadVenue: perpl.reader, now: () => now });

    const first = await service.fills(ALICE, { venue: 'perpl', limit: 20 });
    expect(first).toEqual({
      fills: [
        {
          venue: 'perpl',
          tradeId: null,
          venueTradeId: `0x${'cd'.repeat(32)}:4`,
          orderId: '42',
          symbol: 'BTC-PERP',
          side: 'sell',
          price: '77108.1',
          size: '0.0025',
          // Perpl reports each fill's own fee (SEN-162).
          fee: '0.01',
          feeAsset: 'AUSD',
          transactionHash: `0x${'cd'.repeat(32)}`,
          timestamp: NOW - 5_000,
        },
      ],
      next: 'np-1',
    });
    expect(getFills).toHaveBeenLastCalledWith({ count: 20 });
    expect(await service.fills(ALICE, { venue: 'perpl', limit: 20, cursor: 'np-1' })).toEqual({
      fills: [],
      next: null,
    });
    expect(getFills).toHaveBeenLastCalledWith({ count: 20, page: 'np-1' });

    // The first page again, inside the window: served from memory.
    await service.fills(ALICE, { venue: 'perpl', limit: 20 });
    expect(getFills).toHaveBeenCalledTimes(2);
    now += USER_PERPL_TTL_MS;
    await service.fills(ALICE, { venue: 'perpl', limit: 20 });
    expect(getFills).toHaveBeenCalledTimes(3);
  });

  it("filters a Perpl page to one market and keeps Perpl's cursor (SEN-157)", async () => {
    const eth = { ...PERPL_FILL, tradeId: 'eth:1', symbol: 'ETH-PERP' };
    const perpl = fakePerpl({
      getFills: () => Promise.resolve({ fills: [PERPL_FILL, eth], next: 'np-1' }),
    });
    const { service } = harness({ withPerplReadVenue: perpl.reader });

    const page = await service.fills(ALICE, { venue: 'perpl', symbol: 'ETH-PERP' });
    expect(page).toEqual({
      fills: [expect.objectContaining({ venueTradeId: 'eth:1' })],
      next: 'np-1',
    });
    // The cached page is not the filtered one.
    expect((await service.fills(ALICE, { venue: 'perpl' })).fills).toHaveLength(2);
  });

  it('a failed Perpl fills read is perpl_unavailable', async () => {
    const perpl = fakePerpl({ getFills: () => Promise.reject(new Error('Perpl 503')) });
    const { service } = harness({ withPerplReadVenue: perpl.reader });
    await expect(service.fills(ALICE, { venue: 'perpl' })).rejects.toMatchObject({
      reason: 'perpl_unavailable',
      message: 'Perpl 503',
    });
  });
});

describe('PortfolioController refusals', () => {
  it.each([
    ['perpl_unlinked', 409],
    ['perpl_unavailable', 502],
    ['invalid_cursor', 400],
  ] as const)('%s answers %i with its reason', async (reason, status) => {
    const service = {
      fills: () => Promise.reject(new PortfolioRefusedError(reason, 'no')),
    } as unknown as UserPortfolioService;
    const controller = new PortfolioController(service, { principal: () => ALICE } as never);
    await expect(controller.fills({ venue: 'perpl' })).rejects.toMatchObject({
      status,
      response: expect.objectContaining({ reason }),
    });
  });
});

describe('the trading flag', () => {
  it('gates both routes with the /trade guard', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, PortfolioController);
    expect(guards).toContain(TradingEnabledGuard);
  });

  it('answers 404 trading_disabled with the flag off', () => {
    const guard = new TradingEnabledGuard({
      enabled: false,
      atomicBatch: false,
      perpl: false,
      chainId: 10143,
    });
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
