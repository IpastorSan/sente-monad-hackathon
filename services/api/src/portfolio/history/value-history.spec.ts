import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { AgentRefusedError } from '../../agents/agents.errors';
import type { AgentEvent } from '../../agents/events/agent-event-log';
import type { AgentRecord } from '../../agents/store/agent-store';
import { TradingEnabledGuard } from '../../trade/trade.controller';
import type { Trade } from '../../trade/trade-store';
import type { AgentPortfolioDto, TickerDto } from '../../venues/dto/markets.dto';
import { WalletRefusedError } from '../../wallet/wallet.errors';
import type { PortfolioDto } from '../dto/portfolio.dto';
import { downsample, MAX_POINTS, RANGE_MS, windowStart } from './downsample';
import { agentValuation, priceBook, userValuation } from './valuation';
import { AgentHistoryController, PortfolioHistoryController } from './value-history.controller';
import { ValueHistoryModule } from './value-history.module';
import {
  HOUR_MS,
  loadValueHistoryConfig,
  TRADE_MIN_GAP_MS,
  ValueHistoryService,
  type ValueHistoryReaders,
} from './value-history.service';
import {
  FileValueHistoryStore,
  InMemoryValueHistoryStore,
  type ValueSnapshot,
} from './value-history.store';

const NOW = 1_800_000_000_000;
const DAY = 24 * HOUR_MS;

const quiet = { warn: () => undefined, error: () => undefined };

function ticker(symbol: string, last: string | null, mid: string | null = null): TickerDto {
  return {
    venue: 'kuru',
    symbol,
    quote: 'USDC',
    last,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid,
  } as TickerDto;
}

function userPortfolio(overrides: Partial<PortfolioDto> = {}): PortfolioDto {
  return {
    asOf: NOW,
    wallet: {
      ok: true,
      balances: [
        { symbol: 'USDC', address: '0x', decimals: 6, raw: '0', amount: '10.5' },
        { symbol: 'MON', address: '0x', decimals: 18, raw: '0', amount: '2' },
        { symbol: 'WBTC', address: '0x', decimals: 8, raw: '0', amount: '0' },
      ],
    },
    kuru: {
      ok: true,
      accountId: '1',
      balances: [{ asset: 'USDC', available: '1', locked: '0.25', total: '1.25' }],
      openOrders: [],
    },
    perpl: {
      ok: true,
      status: 'ok',
      accountId: '9',
      // 200 AUSD including the 100 margin the position counts.
      balances: [{ asset: 'AUSD', available: '100', locked: '100', total: '200' }],
      positions: [{ margin: '100', unrealizedPnl: '-2.5' } as never],
      openOrders: [],
    },
    ...overrides,
  };
}

function agentPortfolio(usd: string, overrides: Partial<AgentPortfolioDto> = {}) {
  return {
    agentId: 'a',
    address: '0x',
    asOf: NOW,
    wallet: { ok: true, balances: [] },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl: { ok: true, status: 'not_in_mandate' },
    holdings: [],
    totals: { approxUsd: usd, byQuote: { USDC: usd, AUSD: '0' }, note: '' },
    ...overrides,
  } as unknown as AgentPortfolioDto;
}

describe('valuation', () => {
  const prices = priceBook([ticker('MON-USDC', '3.1'), ticker('WETH-USDC', null, '2000')]);

  it('prices like the phone: stables at $1, the rest at the Kuru last price, Perpl free + positions', () => {
    // 10.5 USDC + 2 MON × 3.1 + 1.25 Kuru USDC + (200 − 100) free + 100 − 2.5 = 215.45
    expect(userValuation(userPortfolio(), prices, [])).toEqual({ usd: '215.45', partial: false });
  });

  it('adds the agents, and a failed agent read makes it partial', () => {
    const agent = { usd: '0.1', partial: false };
    expect(userValuation(userPortfolio(), prices, [agent])).toEqual({
      usd: '215.55',
      partial: false,
    });
    expect(userValuation(userPortfolio(), prices, [agent, null]).partial).toBe(true);
    expect(userValuation(userPortfolio(), prices, [{ usd: '1', partial: true }]).partial).toBe(
      true,
    );
  });

  it('is partial when a section failed, and leaves that section out', () => {
    const value = userValuation(userPortfolio({ kuru: { ok: false, error: 'down' } }), prices, []);
    expect(value).toEqual({ usd: '214.2', partial: true });
  });

  it('leaves an unpriced token out without the flag, but failed prices set it', () => {
    const noMon = priceBook([]);
    expect(userValuation(userPortfolio(), noMon, [])).toEqual({ usd: '209.25', partial: false });
    expect(userValuation(userPortfolio(), null, [])).toEqual({ usd: '209.25', partial: true });
  });

  it('never counts Perpl margin twice, and never below zero free', () => {
    const perpl = {
      ok: true as const,
      status: 'ok' as const,
      balances: [{ asset: 'AUSD', available: '0', locked: '50', total: '50' }],
      positions: [{ margin: '80', unrealizedPnl: '1' } as never],
    };
    const value = userValuation(
      userPortfolio({
        wallet: { ok: true, balances: [] },
        kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
        perpl,
      }),
      prices,
      [],
    );
    expect(value.usd).toBe('81');
  });

  it("takes an agent's own ≈ $ and flags a failed section or an unpriced holding", () => {
    expect(agentValuation(agentPortfolio('12.34'))).toEqual({ usd: '12.34', partial: false });
    expect(
      agentValuation(agentPortfolio('1', { perpl: { ok: false, error: 'x' } } as never)).partial,
    ).toBe(true);
    expect(
      agentValuation(agentPortfolio('1', { holdings: [{ value: null }] } as never)).partial,
    ).toBe(true);
  });
});

describe('downsample and ranges', () => {
  const hourly = (hours: number, end = NOW): ValueSnapshot[] =>
    Array.from({ length: hours }, (_, i) => ({
      at: end - (hours - 1 - i) * HOUR_MS,
      usd: String(i),
    }));

  it('filters to the window of each range', () => {
    const all = hourly(60 * 24);
    for (const range of ['1d', '1w', '1m'] as const) {
      const from = windowStart(all, range, NOW);
      expect(from).toBe(NOW - RANGE_MS[range]);
      const points = downsample(all, from, NOW);
      expect(points.every((p) => p.at >= from && p.at <= NOW)).toBe(true);
    }
    expect(windowStart(all, 'all', NOW)).toBe(all[0]!.at);
    expect(downsample(all, NOW - DAY, NOW)).toHaveLength(25);
  });

  it('keeps every point under the cap', () => {
    const all = hourly(50);
    expect(downsample(all, all[0]!.at, NOW)).toEqual(all);
  });

  it('cuts a long range down to the cap, keeping the first and the newest point', () => {
    const all = hourly(30 * 24);
    const points = downsample(all, all[0]!.at, NOW);
    expect(points.length).toBeLessThanOrEqual(MAX_POINTS + 1);
    expect(points[0]).toBe(all[0]);
    expect(points[points.length - 1]).toBe(all[all.length - 1]);
    const ats = points.map((p) => p.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });
});

describe('the store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'value-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps each subject apart and sorted', () => {
    const store = new InMemoryValueHistoryStore();
    store.append('user', 'u', { at: 2, usd: '2' });
    store.append('user', 'u', { at: 1, usd: '1' });
    store.append('agent', 'u', { at: 3, usd: '3' });
    expect(store.list('user', 'u').map((s) => s.at)).toEqual([1, 2]);
    expect(store.last('agent', 'u')?.usd).toBe('3');
    expect(store.ids('user')).toEqual(['u']);
  });

  it('keeps history across a restart, the partial flag included', () => {
    const path = join(dir, 'value-history.jsonl');
    const first = new FileValueHistoryStore(path, { logger: quiet });
    first.append('user', 'alice', { at: 1, usd: '10.5' });
    first.append('agent', 'a-1', { at: 2, usd: '3', partial: true });
    first.close();

    const second = new FileValueHistoryStore(path, { logger: quiet });
    expect(second.list('user', 'alice')).toEqual([{ at: 1, usd: '10.5' }]);
    expect(second.list('agent', 'a-1')).toEqual([{ at: 2, usd: '3', partial: true }]);
    second.close();
  });

  it('cuts a torn last line and refuses a torn line in the middle', () => {
    const path = join(dir, 'value-history.jsonl');
    const store = new FileValueHistoryStore(path, { logger: quiet });
    store.append('user', 'alice', { at: 1, usd: '1' });
    store.close();
    appendFileSync(path, '{"v":1,"k":"user","id":"alice","s":{"at":2,');
    const repaired = new FileValueHistoryStore(path, { logger: quiet });
    expect(repaired.size).toBe(1);
    repaired.close();

    writeFileSync(path, `garbage\n${readFileSync(path, 'utf8')}`);
    expect(() => new FileValueHistoryStore(path, { logger: quiet })).toThrow(/line 1/);
  });

  it('drops the oldest past the per-subject cap and compacts the file at boot', () => {
    const path = join(dir, 'value-history.jsonl');
    const store = new FileValueHistoryStore(path, { maxPerSubject: 10, logger: quiet });
    for (let i = 0; i < 1_100; i += 1) store.append('user', 'alice', { at: i, usd: String(i) });
    store.close();
    const reopened = new FileValueHistoryStore(path, { maxPerSubject: 10, logger: quiet });
    expect(reopened.list('user', 'alice')[0]?.at).toBe(1_090);
    reopened.close();
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(10);
  });
});

describe('ValueHistoryService', () => {
  const AGENT = { id: 'a-1', userId: 'alice', status: 'active' } as AgentRecord;

  function harness(overrides: Partial<ValueHistoryReaders> = {}) {
    let now = NOW;
    const store = new InMemoryValueHistoryStore();
    const trades: Trade[] = [];
    const fills: AgentEvent[] = [];
    const userReads: string[] = [];
    const agentReads: string[] = [];
    const readers: ValueHistoryReaders = {
      store,
      userPortfolio: (principal) => {
        userReads.push(principal.userId);
        if (principal.userId === 'nobody') {
          return Promise.reject(new WalletRefusedError('account_not_registered', 'no'));
        }
        return Promise.resolve(userPortfolio());
      },
      agentPortfolio: (agent) => {
        agentReads.push(agent.id);
        return Promise.resolve(agentPortfolio('5'));
      },
      kuruTickers: () => Promise.resolve([ticker('MON-USDC', '3.1')]),
      agents: { listAll: () => Promise.resolve([AGENT]) },
      trades: { listRecent: () => trades },
      events: {
        list: (_id, query) => Promise.resolve(query?.kind === 'fill' ? fills.slice(-1) : []),
      },
      tradingEnabled: true,
      now: () => now,
      ...overrides,
    };
    const service = new ValueHistoryService(readers, { everyMs: HOUR_MS, tickSeconds: undefined });
    return {
      service,
      store,
      trades,
      fills,
      userReads,
      agentReads,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('snapshots every agent and its owner, then waits an hour', async () => {
    const h = harness();
    expect(await h.service.tick()).toEqual({ users: 1, agents: 1 });
    // Alice's total is her own 215.45 plus her agent's 5.
    expect(h.store.list('user', 'alice')).toEqual([{ at: NOW, usd: '220.45' }]);
    expect(h.store.list('agent', 'a-1')).toEqual([{ at: NOW, usd: '5' }]);

    h.advance(HOUR_MS - 1);
    expect(await h.service.tick()).toEqual({ users: 0, agents: 0 });
    h.advance(1);
    expect(await h.service.tick()).toEqual({ users: 1, agents: 1 });
    expect(h.store.list('user', 'alice')).toHaveLength(2);
  });

  it('takes an extra point after a landed trade, at most every few minutes', async () => {
    const h = harness();
    await h.service.tick();
    h.advance(60_000);
    h.trades.push({ status: 'completed', updatedAt: new Date(NOW + 30_000) } as Trade);
    h.fills.push({ at: NOW + 30_000, kind: 'fill' } as AgentEvent);
    expect(await h.service.tick()).toEqual({ users: 0, agents: 0 });
    h.advance(TRADE_MIN_GAP_MS);
    expect(await h.service.tick()).toEqual({ users: 1, agents: 1 });
    h.advance(TRADE_MIN_GAP_MS);
    // Nothing new since that point.
    expect(await h.service.tick()).toEqual({ users: 0, agents: 0 });
  });

  it('ignores a trade that did not land', async () => {
    const h = harness();
    await h.service.tick();
    h.advance(TRADE_MIN_GAP_MS);
    h.trades.push({ status: 'failed', updatedAt: new Date(NOW + 1) } as Trade);
    expect((await h.service.tick()).users).toBe(0);
  });

  it('records users only while manual trading is on', async () => {
    const h = harness({ tradingEnabled: false });
    expect(await h.service.tick()).toEqual({ users: 0, agents: 1 });
    expect(h.userReads).toEqual([]);
  });

  it('tracks a user who asked, and stops on one with no wallet', async () => {
    const h = harness({ agents: { listAll: () => Promise.resolve([]) } });
    h.service.track('bob');
    h.service.track('nobody');
    expect((await h.service.tick()).users).toBe(1);
    h.advance(HOUR_MS);
    await h.service.tick();
    expect(h.userReads.filter((u) => u === 'nobody')).toHaveLength(1);
    expect(h.store.list('user', 'bob')).toHaveLength(2);
  });

  it('marks a point partial when an agent read fails', async () => {
    const h = harness({ agentPortfolio: () => Promise.reject(new Error('rpc down')) });
    await h.service.tick();
    expect(h.store.list('agent', 'a-1')).toEqual([]);
    expect(h.store.last('user', 'alice')).toEqual({ at: NOW, usd: '215.45', partial: true });
  });

  it('stops charting a revoked agent once it is empty', async () => {
    const revoked = { ...AGENT, status: 'revoked' } as AgentRecord;
    const h = harness({ agents: { listAll: () => Promise.resolve([revoked]) } });
    h.store.append('agent', 'a-1', { at: NOW - 2 * HOUR_MS, usd: '0' });
    await h.service.tick();
    expect(h.store.list('agent', 'a-1')).toHaveLength(1);
    // Nor read for its owner's total, which still gets its point.
    expect(h.agentReads).toEqual([]);
    expect(h.store.last('user', 'alice')?.usd).toBe('215.45');
  });

  it('serves a range with its partial flag, and restarts keep the chart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'value-history-'));
    try {
      const path = join(dir, 'value-history.jsonl');
      const file = new FileValueHistoryStore(path, { logger: quiet });
      const h = harness({ store: file, agentPortfolio: () => Promise.reject(new Error('x')) });
      await h.service.tick();
      file.close();

      const reopened = new FileValueHistoryStore(path, { logger: quiet });
      const after = harness({ store: reopened, now: () => NOW + 10 * DAY });
      expect(after.service.history('user', 'alice', '1d').points).toEqual([]);
      const all = after.service.history('user', 'alice', 'all');
      expect(all).toMatchObject({
        range: 'all',
        asOf: NOW + 10 * DAY,
        from: NOW,
        points: [{ at: NOW, usd: '215.45', partial: true }],
        partial: true,
        everyMs: HOUR_MS,
      });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config', () => {
  it('defaults to a 60 s tick and hourly points, and can turn the timer off', () => {
    expect(loadValueHistoryConfig({})).toEqual({ everyMs: HOUR_MS, tickSeconds: 60 });
    expect(
      loadValueHistoryConfig({ VALUE_HISTORY_TICK_SECONDS: 'off' }).tickSeconds,
    ).toBeUndefined();
    expect(() => loadValueHistoryConfig({ VALUE_HISTORY_EVERY_SECONDS: '5' })).toThrow();
  });
});

describe('the routes', () => {
  it('gates /portfolio/history like /portfolio', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, PortfolioHistoryController);
    expect(guards).toContain(TradingEnabledGuard);
  });

  it('tracks the caller and defaults to 1d', () => {
    const history = { track: jest.fn(), history: jest.fn(() => ({})) };
    const controller = new PortfolioHistoryController(
      history as never,
      {
        principal: () => ({ userId: 'alice' }),
      } as never,
    );
    controller.portfolioHistory({});
    expect(history.track).toHaveBeenCalledWith('alice');
    expect(history.history).toHaveBeenCalledWith('user', 'alice', '1d');
  });

  it("answers 404 for another user's agent before reading anything", async () => {
    const history = { history: jest.fn() };
    const agents = {
      get: () => Promise.reject(new AgentRefusedError('agent_not_found', 'no such agent')),
    };
    const controller = new AgentHistoryController(
      history as never,
      agents as never,
      {
        principal: () => ({ userId: 'alice' }),
      } as never,
    );
    await expect(controller.agentHistory({ id: 'a-2' }, { range: '1w' })).rejects.toMatchObject({
      status: 404,
    });
    expect(history.history).not.toHaveBeenCalled();
  });

  it("serves the owner's agent", async () => {
    const history = { history: jest.fn(() => ({ points: [] })) };
    const agents = { get: () => Promise.resolve({ id: 'a-1' }) };
    const controller = new AgentHistoryController(
      history as never,
      agents as never,
      {
        principal: () => ({ userId: 'alice' }),
      } as never,
    );
    await controller.agentHistory({ id: 'a-1' }, { range: '1w' });
    expect(history.history).toHaveBeenCalledWith('agent', 'a-1', '1w');
  });
});

describe('the module', () => {
  it('boots with the portfolio and agent modules it reads through', async () => {
    const saved = { ...process.env };
    delete process.env.STATE_DIR;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [ValueHistoryModule] }).compile();
      expect(moduleRef.get(ValueHistoryService)).toBeInstanceOf(ValueHistoryService);
      await moduleRef.close();
    } finally {
      process.env = saved;
    }
  });
});
