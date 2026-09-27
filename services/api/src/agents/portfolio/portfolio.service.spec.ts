import type { Balance, Order, Position } from '@sente/venues';
import type { PerplVenue } from '@sente/venues/perpl';
import { getAddress, type Address, type PublicClient } from 'viem';

import type { TokenBalance } from '../../wallet/balances/token-balances';
import type { AgentWalletProvider } from '../agent-wallet.provider';
import type { AgentEvent } from '../events/agent-event-log';
import type { AgentRecord } from '../store/agent-store';
import { InMemoryAgentSecretStore } from '../venues/agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from '../venues/agent-transactions';
import { AgentVenues } from '../venues/agent-venues';
import type { PerplAccountInfo } from '../venues/perpl-agent';
import {
  AGENT_PERPL_STALE_MS,
  AGENT_PERPL_TTL_MS,
  AGENT_PORTFOLIO_TTL_MS,
  AgentPortfolioService,
  agentPortfolioReaders,
  type AgentPortfolioReaders,
} from './portfolio.service';
import type { KuruAccountVenue, PerplAccountVenue } from './venue-reads';

const ADDRESS = getAddress('0x4444444444444444444444444444444444444444');

function agent(venues: string[] = ['kuru', 'perpl']): AgentRecord {
  return {
    id: 'agent-1',
    walletId: 'wallet-1',
    address: ADDRESS,
    mandate: { venues },
  } as unknown as AgentRecord;
}

function token(symbol: string, amount: string, decimals = 18): TokenBalance {
  return { symbol, address: ADDRESS, decimals, raw: 0n, amount };
}

function balance(asset: string, available: string, locked = '0'): Balance {
  const total = (Number(available) + Number(locked)).toString(); // test values are small integers
  return { asset, available, locked, total };
}

const KURU_ORDER: Order = {
  id: '77',
  symbol: 'MON-USDC',
  side: 'sell',
  type: 'limit',
  status: 'open',
  price: '4',
  size: '2',
  filledSize: '0',
  createdAt: 1,
  updatedAt: 2,
};

const POSITION: Position = {
  symbol: 'BTC',
  side: 'long',
  size: '0.01',
  entryPrice: '60000',
  markPrice: '61000',
  leverage: 3,
  marginMode: 'isolated',
  margin: '200',
  unrealizedPnl: '10',
  updatedAt: 5,
};

/** A fill as the gate records it. */
function buy(seq: number, size: string, price: string): AgentEvent {
  return {
    seq,
    agentId: 'agent-1',
    at: seq,
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'MON-USDC',
      side: 'buy',
      filledSize: size,
      averageFillPrice: price,
    },
  };
}

interface Harness {
  service: AgentPortfolioService;
  readers: AgentPortfolioReaders;
  clock: { now: number };
  calls: { wallet: number };
}

function harness(over: Partial<AgentPortfolioReaders> = {}): Harness {
  const clock = { now: 1_000_000 };
  const calls = { wallet: 0 };
  const kuru: KuruAccountVenue = {
    accountId: () => Promise.resolve(9n),
    getBalances: () => Promise.resolve([balance('MON', '3', '2'), balance('USDC', '100', '0')]),
    getOpenOrders: () => Promise.resolve([KURU_ORDER]),
  };
  const readers: AgentPortfolioReaders = {
    wallet: {
      balances: () => {
        calls.wallet += 1;
        return Promise.resolve([
          token('MON', '5'),
          token('USDC', '50', 6),
          token('WETH', '0'),
          token('AUSD', '20', 6),
        ]);
      },
    },
    kuruVenue: (address: Address) => {
      expect(address).toBe(ADDRESS);
      return kuru;
    },
    withPerplVenue: (_agent, read) => read(undefined),
    holdsPerplSocket: () => false,
    perplAccountInfo: () =>
      Promise.resolve<PerplAccountInfo>({ accountId: 12n, balance: 150_000_000n, locked: 0n }),
    events: { list: () => Promise.resolve([buy(1, '4', '2')]) },
    marks: { mark: (_venue, symbol) => Promise.resolve(symbol === 'MON-USDC' ? '3' : null) },
    now: () => clock.now,
    ...over,
  };
  return { service: new AgentPortfolioService(readers), readers, clock, calls };
}

describe('AgentPortfolioService (SEN-78)', () => {
  it('reads every section when all venues answer', async () => {
    const perpl: PerplAccountVenue = {
      getBalances: () => Promise.resolve([balance('AUSD', '100', '200')]),
      getPositions: () => Promise.resolve([POSITION]),
      getOpenOrders: () => Promise.resolve([]),
    };
    const { service } = harness({ withPerplVenue: (_agent, read) => read(perpl) });

    const p = await service.portfolio(agent());

    expect(p).toMatchObject({ agentId: 'agent-1', address: ADDRESS, asOf: 1_000_000 });
    expect(p.wallet).toEqual({
      ok: true,
      balances: [
        { asset: 'MON', available: '5', locked: '0', total: '5', decimals: 18 },
        { asset: 'USDC', available: '50', locked: '0', total: '50', decimals: 6 },
        { asset: 'WETH', available: '0', locked: '0', total: '0', decimals: 18 },
        { asset: 'AUSD', available: '20', locked: '0', total: '20', decimals: 6 },
      ],
    });
    expect(p.kuru).toEqual({
      ok: true,
      accountId: '9',
      balances: [
        { asset: 'MON', available: '3', locked: '2', total: '5' },
        { asset: 'USDC', available: '100', locked: '0', total: '100' },
      ],
      openOrders: [
        {
          venue: 'kuru',
          id: '77',
          symbol: 'MON-USDC',
          side: 'sell',
          type: 'limit',
          status: 'open',
          price: '4',
          size: '2',
          filledSize: '0',
          leverage: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    expect(p.perpl).toEqual({
      ok: true,
      status: 'ok',
      asOf: 1_000_000,
      accountId: '12',
      balances: [{ asset: 'AUSD', available: '100', locked: '200', total: '300' }],
      positions: [
        {
          symbol: 'BTC',
          side: 'long',
          size: '0.01',
          entryPrice: '60000',
          markPrice: '61000',
          liquidationPriceEst: null,
          leverage: 3,
          margin: '200',
          unrealizedPnl: '10',
          realizedPnl: null,
          fundingPaid: null,
          quote: 'AUSD',
          updatedAt: 5,
        },
      ],
      openOrders: [],
    });
    // Only MON is held: WETH reads zero everywhere and is left out.
    expect(p.holdings.map((h) => h.asset)).toEqual(['MON']);
    // USDC: 50 wallet + 100 Kuru + 10 MON x 3; AUSD: 20 wallet + 300 Perpl + 10 uPnL.
    expect(p.totals).toMatchObject({
      approxUsd: '510',
      byQuote: { USDC: '180', AUSD: '330' },
    });
    expect(p.totals.note).toContain('≈ $');
  });

  it('values a holding across wallet, account and orders, uPnL on the covered size only', async () => {
    const { service } = harness();

    const [mon] = (await service.portfolio(agent())).holdings;

    // 5 in the wallet + 3 free + 2 reserved = 10 held; the log explains 4 bought at 2.
    expect(mon).toEqual({
      asset: 'MON',
      market: 'MON-USDC',
      amount: '10',
      inWallet: '5',
      inAccount: '3',
      lockedInOrders: '2',
      markPrice: '3',
      value: '30',
      costBasis: {
        avgPrice: '2',
        coveredSize: '4',
        uncoveredSize: '6',
        unrealizedPnl: '4', // (3 - 2) x 4 covered, not x 10 held
        complete: false,
        source: 'event-log-fifo',
      },
      note: 'Wallet MON includes gas.',
    });
  });

  it('falls back to the chain for a Perpl account without credentials', async () => {
    const { service } = harness({
      perplAccountInfo: () =>
        Promise.resolve({ accountId: 12n, balance: 150_500_000n, locked: 500_000n }),
    });

    const { perpl } = await service.portfolio(agent());

    expect(perpl).toEqual({
      ok: true,
      status: 'not_enrolled',
      asOf: 1_000_000,
      accountId: '12',
      balances: [{ asset: 'AUSD', available: '150', locked: '0.5', total: '150.5' }],
      positions: null,
      openOrders: null,
    });
  });

  it('says no_account when the address never opened one, and not_in_mandate when Perpl is off', async () => {
    const none = harness({ perplAccountInfo: () => Promise.resolve(null) });
    expect((await none.service.portfolio(agent())).perpl).toEqual({
      ok: true,
      status: 'no_account',
      asOf: 1_000_000,
    });

    const off = harness({
      perplAccountInfo: () => Promise.reject(new Error('must not be read')),
    });
    expect((await off.service.portfolio(agent(['kuru']))).perpl).toEqual({
      ok: true,
      status: 'not_in_mandate',
    });
  });

  it('reports an empty Kuru account (id 0) without reading balances or orders', async () => {
    const { service } = harness({
      kuruVenue: () => ({
        accountId: () => Promise.resolve(0n),
        getBalances: () => Promise.reject(new Error('must not be read')),
        getOpenOrders: () => Promise.reject(new Error('must not be read')),
      }),
    });

    expect((await service.portfolio(agent())).kuru).toEqual({
      ok: true,
      accountId: null,
      balances: [],
      openOrders: [],
    });
  });

  it('keeps the other sections when a Kuru read throws', async () => {
    const { service } = harness({
      kuruVenue: () => ({
        accountId: () => Promise.reject(new Error('Gateway 503')),
        getBalances: () => Promise.resolve([]),
        getOpenOrders: () => Promise.resolve([]),
      }),
    });

    const p = await service.portfolio(agent());

    expect(p.kuru).toEqual({ ok: false, error: 'Gateway 503' });
    expect(p.wallet.ok).toBe(true);
    expect(p.perpl).toMatchObject({ ok: true, status: 'not_enrolled' });
    expect(p.holdings[0]).toMatchObject({
      amount: '5',
      inAccount: '0',
      note: expect.stringContaining('Kuru read failed'),
    });
    expect(p.totals.note).toContain('Leaves out Kuru');
  });

  it('prices nothing without a mark and still reports the holding', async () => {
    const { service } = harness({ marks: { mark: () => Promise.reject(new Error('down')) } });

    const [mon] = (await service.portfolio(agent())).holdings;

    expect(mon).toMatchObject({ markPrice: null, value: null });
    expect(mon!.costBasis.unrealizedPnl).toBeNull();
  });

  it('serves one read per agent for 3 s, concurrent callers included', async () => {
    const h = harness();

    const [a, b] = await Promise.all([h.service.portfolio(agent()), h.service.portfolio(agent())]);
    h.clock.now += AGENT_PORTFOLIO_TTL_MS - 1;
    const c = await h.service.portfolio(agent());

    expect(h.calls.wallet).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);

    h.clock.now += 1;
    const d = await h.service.portfolio(agent());
    expect(h.calls.wallet).toBe(2);
    expect(d.asOf).toBe(1_000_000 + AGENT_PORTFOLIO_TTL_MS);
  });
});

/**
 * SEN-122: the phone polls the portfolio every few seconds. Each read used to
 * go through `AgentVenues.forAgent`, keeping the agent's authenticated Perpl
 * socket open for as long as anyone watched; and a throwaway socket per poll
 * instead would sign in up to 20 times a minute against Perpl's ~10/min. These
 * run the real `AgentVenues` and wiring over a fake venue that counts socket
 * opens (the first account read, as `PerplVenue` connects lazily) and closes.
 */
describe('AgentPortfolioService Perpl sockets (SEN-122)', () => {
  const IDLE_MS = 60_000;
  const T0 = 1_000_000;

  afterEach(() => jest.useRealTimers());

  async function sockets() {
    const secrets = new InMemoryAgentSecretStore();
    await secrets.putPerplCredentials('agent-1', { apiKey: 'k1', secretKey: new Uint8Array(32) });
    const count = { created: 0, opened: 0, closed: 0 };
    const perplDown = { value: false };
    const venues = new AgentVenues({
      publicClient: {} as PublicClient,
      sender: new AgentTransactionSender({
        wallets: {} as AgentWalletProvider,
        chain: {} as AgentChainClient,
      }),
      secrets,
      idleMs: IDLE_MS,
      createPerplVenue: () => {
        count.created += 1;
        let open = false;
        const connect = <T>(value: T) => {
          if (!open) count.opened += 1;
          open = true;
          return perplDown.value
            ? Promise.reject(new Error('Perpl: rate limited'))
            : Promise.resolve(value);
        };
        const fake: PerplAccountVenue & Pick<PerplVenue, 'close'> = {
          getBalances: () => connect([balance('AUSD', '100')]),
          getPositions: () => connect([POSITION]),
          getOpenOrders: () => connect([]),
          close: () => {
            if (open) count.closed += 1;
            open = false;
          },
        };
        return fake as unknown as PerplVenue;
      },
    });
    const wired = agentPortfolioReaders(
      {} as PublicClient,
      venues,
      { list: jest.fn() },
      { mark: jest.fn() },
    );
    const h = harness({
      withPerplVenue: wired.withPerplVenue,
      holdsPerplSocket: wired.holdsPerplSocket,
    });
    return { ...h, venues, count, perplDown };
  }

  it('opens at most one temporary socket for any number of polls within 30 s, and closes it', async () => {
    const h = await sockets();

    // Two polls a portfolio TTL apart while the first Perpl read is still in
    // flight: the second joins it rather than opening its own socket.
    const first = h.service.portfolio(agent());
    h.clock.now += AGENT_PORTFOLIO_TTL_MS;
    const second = h.service.portfolio(agent());
    await Promise.all([first, second]);

    while (h.clock.now + AGENT_PORTFOLIO_TTL_MS < T0 + AGENT_PERPL_TTL_MS) {
      h.clock.now += AGENT_PORTFOLIO_TTL_MS;
      const p = await h.service.portfolio(agent());
      expect(p.asOf).toBe(h.clock.now);
      expect(p.perpl).toMatchObject({ ok: true, status: 'ok', asOf: T0, positions: [{}] });
      expect(p.perpl).not.toHaveProperty('stale');
    }
    expect(h.count).toEqual({ created: 1, opened: 1, closed: 1 });

    h.clock.now = T0 + AGENT_PERPL_TTL_MS;
    const later = await h.service.portfolio(agent());
    expect(later.perpl).toMatchObject({ ok: true, asOf: T0 + AGENT_PERPL_TTL_MS });
    expect(h.count).toEqual({ created: 2, opened: 2, closed: 2 });
    expect(h.venues.size).toBe(0);
  });

  it('serves the last good read flagged stale for up to 2 min when Perpl fails', async () => {
    const h = await sockets();
    await h.service.portfolio(agent());

    h.perplDown.value = true;
    h.clock.now = T0 + AGENT_PERPL_TTL_MS;
    const stale = await h.service.portfolio(agent());
    expect(stale.perpl).toMatchObject({ ok: true, status: 'ok', asOf: T0, stale: true });
    // Totals still count the stale Perpl collateral rather than dropping it.
    expect(stale.totals.note).not.toContain('Leaves out');

    // The failure is rationed like a success: no retry for another 30 s.
    h.clock.now += AGENT_PORTFOLIO_TTL_MS;
    await h.service.portfolio(agent());
    expect(h.count.created).toBe(2);

    h.clock.now = T0 + AGENT_PERPL_STALE_MS + 1;
    const gone = await h.service.portfolio(agent());
    expect(gone.perpl).toEqual({ ok: false, error: 'Perpl: rate limited' });
    expect(h.count).toEqual({ created: 3, opened: 3, closed: 3 });
  });

  it("borrows the agent run's live socket each poll, without closing it or extending its idle time", async () => {
    jest.useFakeTimers();
    const h = await sockets();
    const run = await h.venues.forAgent({
      agentId: 'agent-1',
      walletId: 'wallet-1',
      address: ADDRESS,
    });
    await run.perpl!.getPositions();

    jest.advanceTimersByTime(IDLE_MS - 1);
    const p = await h.service.portfolio(agent());
    expect(p.perpl).toMatchObject({ ok: true, status: 'ok', asOf: T0 });
    // A borrowed read costs no sign-in, so it is not held for 30 s.
    h.clock.now += AGENT_PORTFOLIO_TTL_MS;
    const q = await h.service.portfolio(agent());
    expect(q.perpl).toMatchObject({ ok: true, asOf: T0 + AGENT_PORTFOLIO_TTL_MS });
    expect(h.count).toEqual({ created: 1, opened: 1, closed: 0 });

    // The polls did not touch the idle timer: the run's socket closes on schedule.
    jest.advanceTimersByTime(1);
    expect(h.count).toEqual({ created: 1, opened: 1, closed: 1 });
    expect(h.venues.size).toBe(0);

    // With the run's socket gone, the borrowed read above stands in for 30 s.
    h.clock.now += AGENT_PORTFOLIO_TTL_MS;
    const r = await h.service.portfolio(agent());
    expect(r.perpl).toMatchObject({ ok: true, asOf: T0 + AGENT_PORTFOLIO_TTL_MS });
    expect(h.count.created).toBe(1);
  });
});
