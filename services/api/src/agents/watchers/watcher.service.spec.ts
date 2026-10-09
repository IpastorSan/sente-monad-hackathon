import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpException } from '@nestjs/common';
import type { Position } from '@sente/venues';

import type { TickerDto } from '../../venues/dto/markets.dto';
import { AgentsService } from '../agents.service';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentStore } from '../store/agent-store';
import { FakeAgentWalletProvider } from '../testing/fake-agent-wallet.provider';
import { AgentTools } from '../tools/context';
import { GATED_TOOLS, type ToolOutcome } from '../tools/gate';
import { testAgent, testMandateInput } from '../tools/testing/agent-fixture';
import { fakeVenues } from '../tools/testing/fake-venues';
import { parseMandate } from '@sente/mandate';
import { FileWatcherStore, InMemoryWatcherStore } from './watcher-store';
import { WatcherService, type WatcherServiceOptions } from './watcher.service';
import { WatchersController } from './watchers.controller';

const T0 = Date.parse('2026-10-09T10:00:00.000Z');

const BREAKOUT = {
  id: 'breakout',
  label: 'BTC breaks 100k',
  clauses: [
    { type: 'price', venue: 'perpl', market: 'BTC-PERP', op: 'crosses_above', value: 100_000 },
  ],
};
const CHEAP = {
  label: 'MON cheap',
  clauses: [{ type: 'price', venue: 'kuru', market: 'MON-USDC', op: 'below', value: 3 }],
};

function ticker(patch: Partial<TickerDto>): TickerDto {
  return {
    venue: 'perpl',
    symbol: 'BTC-PERP',
    quote: 'AUSD',
    last: null,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct: null,
    quoteVolume24h: null,
    funding: null,
    stale: false,
    asOf: T0,
    ...patch,
  } as TickerDto;
}

function service(
  options: Partial<WatcherServiceOptions> & { tickers?: Record<string, TickerDto> } = {},
) {
  const tickers = options.tickers ?? {};
  return new WatcherService({
    store: options.store ?? new InMemoryWatcherStore(),
    marketData: {
      ticker: (_venue, symbol) =>
        tickers[symbol] ? Promise.resolve(tickers[symbol]) : Promise.reject(new Error('down')),
      klines: () => Promise.reject(new Error('not read here')),
    },
    ...(options.positionsOf ? { positionsOf: options.positionsOf } : {}),
  });
}

describe('WatcherService (SEN-182)', () => {
  it('round-trips a set, edge state and counters through STATE_DIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sente-watchers-'));
    try {
      const path = join(dir, 'agent-watchers.json');
      const agent = testAgent();
      const tickers = { 'BTC-PERP': ticker({ mark: '99000' }) };
      const first = service({ store: new FileWatcherStore(path), tickers });
      first.replace(agent, { watchers: [BREAKOUT, CHEAP], heartbeatHours: 2 }, 'agent', T0);
      await first.check(agent, T0 + 60_000);
      first.record(agent.id, 'skipped', T0 + 60_000);

      const reloaded = new FileWatcherStore(path);
      expect(reloaded.size).toBe(1);
      const set = reloaded.get(agent.id)!;
      expect(set).toMatchObject({ heartbeatSeconds: 7_200, checks: 1, skipped: 1 });
      expect(set.watchers.map((w) => w.id)).toEqual(['breakout', expect.stringMatching(/^w-/)]);
      // BTC was below 100k: the edge is remembered, so the next cross is seen after a restart.
      expect(set.watchers[0]!.edges).toEqual([false]);

      const second = service({
        store: reloaded,
        tickers: { 'BTC-PERP': ticker({ mark: '101000' }) },
      });
      const { fired } = await second.check(agent, T0 + 120_000);
      expect(fired).toEqual([
        {
          id: 'breakout',
          label: 'BTC breaks 100k',
          observed: 'BTC-PERP mark 101000 crossed above 100000',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a watcher’s state when it is set again unchanged, and resets it when its condition changes', async () => {
    const agent = testAgent();
    const s = service({ tickers: { 'BTC-PERP': ticker({ mark: '99000' }) } });
    s.replace(agent, { watchers: [BREAKOUT] }, 'agent', T0);
    await s.check(agent, T0 + 1);
    s.replace(agent, { watchers: [BREAKOUT] }, 'agent', T0 + 2);
    expect(s.get(agent.id)!.watchers[0]!.edges).toEqual([false]);

    const moved = { ...BREAKOUT, clauses: [{ ...BREAKOUT.clauses[0]!, value: 110_000 }] };
    s.replace(agent, { watchers: [moved] }, 'agent', T0 + 3);
    expect(s.get(agent.id)!.watchers[0]!.edges).toEqual([null]);
  });

  it('adds, edits and deletes one watcher, up to eight', () => {
    const agent = testAgent();
    const s = service();
    s.upsert(agent, 'a', CHEAP, 'owner', T0);
    s.upsert(agent, 'a', { ...CHEAP, label: 'MON very cheap' }, 'owner', T0);
    expect(s.view(agent.id).watchers.map((w) => [w.id, w.label, w.setBy])).toEqual([
      ['a', 'MON very cheap', 'owner'],
    ]);
    for (let i = 0; i < 7; i++) s.upsert(agent, `x${i}`, CHEAP, 'owner', T0);
    expect(() => s.upsert(agent, 'ninth', CHEAP, 'owner', T0)).toThrow(/at most 8/);
    expect(s.remove(agent.id, 'a')).toBe(true);
    expect(s.remove(agent.id, 'a')).toBe(false);
    expect(s.view(agent.id).watchers).toHaveLength(7);
  });

  it('stops reading a market the mandate no longer allows', async () => {
    const agent = testAgent();
    const s = service({ tickers: { 'BTC-PERP': ticker({ mark: '99000' }) } });
    s.replace(agent, { watchers: [BREAKOUT] }, 'agent', T0);
    const amended = testAgent({
      mandate: parseMandate({ ...testMandateInput(), venues: ['kuru'] }),
    });
    await s.check(amended, T0 + 1);
    expect(s.get(agent.id)!.watchers[0]!.lastError).toMatch(/no longer in the mandate/);
  });

  it('reads funding as % per 8 h, and P&L as a % of the position margin', async () => {
    const agent = testAgent();
    const s = service({
      tickers: {
        'BTC-PERP': ticker({
          mark: '1',
          funding: { rate: '0.0001', intervalHours: 1, nextAt: null },
        }),
      },
      positionsOf: () =>
        Promise.resolve([
          { symbol: 'BTC-PERP', margin: '200', unrealizedPnl: '-12.5' } as Position,
        ]),
    });
    s.replace(
      agent,
      {
        watchers: [
          {
            id: 'f',
            label: 'f',
            clauses: [{ type: 'funding', market: 'BTC-PERP', op: 'above', value: 0.05 }],
          },
          {
            id: 'p',
            label: 'p',
            clauses: [{ type: 'position', market: 'BTC-PERP', op: 'pnl_below', value: -5 }],
          },
        ],
      },
      'agent',
      T0,
    );
    const { fired } = await s.check(agent, T0 + 1);
    expect(fired.map((f) => f.observed)).toEqual([
      'BTC-PERP funding 0.08%/8h is above 0.05%/8h',
      'your BTC-PERP P&L -6.25% of margin is below -5%',
    ]);
  });
});

describe('watcher tools (SEN-182)', () => {
  async function harness() {
    const store = new InMemoryAgentStore();
    const agent = testAgent();
    await store.insert(agent);
    const events = new InMemoryAgentEventLog();
    const watchers = service({ tickers: { 'BTC-PERP': ticker({ mark: '1' }) } });
    const venues = fakeVenues();
    const tools = new AgentTools({
      store,
      events,
      precheck: true,
      venuesFor: () => Promise.resolve(venues.venues),
      watchers,
    });
    const ctx = tools.context(agent);
    const call = (name: string, args: unknown): Promise<ToolOutcome> =>
      GATED_TOOLS.find((t) => t.name === name)!.invoke(ctx, args);
    return { store, agent, events, watchers, call };
  }

  it('sets, lists and clears the agent’s watchers', async () => {
    const h = await harness();
    const set = await h.call('set_watchers', { watchers: [BREAKOUT, CHEAP], heartbeatHours: 6 });
    expect(set).toMatchObject({
      ok: true,
      result: {
        set: 2,
        heartbeatHours: 6,
        watchers: [
          {
            id: 'breakout',
            reads: 'BTC-PERP mark crosses above 100000',
            setBy: 'agent',
            fireCount: 0,
          },
          { label: 'MON cheap', reads: 'MON-USDC mark is below 3' },
        ],
      },
    });
    expect(await h.call('list_watchers', {})).toMatchObject({
      ok: true,
      result: { watchers: [{ id: 'breakout' }, { label: 'MON cheap' }] },
    });
    expect(await h.call('clear_watchers', {})).toEqual({ ok: true, result: { cleared: 2 } });
    expect(h.watchers.has(h.agent.id)).toBe(false);
    // Setting watchers is not trading: nothing lands on the agent's record of account.
    expect(await h.events.list(h.agent.id)).toEqual([]);
  });

  it('refuses a market outside the mandate as Sente, and changes nothing', async () => {
    const h = await harness();
    await h.call('set_watchers', { watchers: [CHEAP] });
    const outside = await h.call('set_watchers', {
      watchers: [
        {
          label: 'eth',
          clauses: [{ type: 'price', venue: 'kuru', market: 'WETH-USDC', op: 'above', value: 1 }],
        },
      ],
    });
    expect(outside).toMatchObject({
      ok: false,
      refusal: { layer: 'sente', code: 'market_not_allowed' },
    });
    expect(h.watchers.view(h.agent.id).watchers.map((w) => w.label)).toEqual(['MON cheap']);
  });

  it('refuses a revoked agent', async () => {
    const h = await harness();
    await h.store.update(h.agent.id, { status: 'revoked' });
    expect(await h.call('set_watchers', { watchers: [CHEAP] })).toMatchObject({
      ok: false,
      refusal: { code: 'agent_inactive' },
    });
  });
});

describe('GET/PUT/DELETE /agents/:id/watchers (SEN-182)', () => {
  async function harness() {
    const store = new InMemoryAgentStore();
    const agent = testAgent();
    await store.insert(agent);
    const agents = new AgentsService(
      store,
      new FakeAgentWalletProvider(),
      new ServerMandateOwners(),
    );
    const watchers = service();
    let userId = agent.userId;
    const controller = new WatchersController(agents, { principal: () => ({ userId }) }, watchers, {
      cadenceOf: () => ({ everySeconds: 300, source: 'agent' }),
    } as never);
    return { agent, watchers, controller, as: (id: string) => (userId = id) };
  }

  async function httpError(promise: Promise<unknown>) {
    const error: unknown = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof HttpException))
      throw new Error(`expected HttpException: ${String(error)}`);
    return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  }

  it('lets the owner read, add, edit and delete, with the tool’s validation', async () => {
    const h = await harness();
    const id = { id: h.agent.id };
    expect(await h.controller.list(id)).toMatchObject({
      everySeconds: 300,
      watchers: [],
      modelCallsSaved: 0,
    });

    const added = await h.controller.upsert({ ...id, wid: 'cheap' }, CHEAP);
    expect(added.watchers).toMatchObject([
      { id: 'cheap', setBy: 'owner', reads: 'MON-USDC mark is below 3' },
    ]);

    expect(
      await httpError(h.controller.upsert({ ...id, wid: 'cheap' }, { ...CHEAP, clauses: [] })),
    ).toMatchObject({
      status: 400,
      body: { reason: 'invalid_input' },
    });
    expect(
      await httpError(
        h.controller.upsert(
          { ...id, wid: 'eth' },
          {
            label: 'eth',
            clauses: [{ type: 'price', venue: 'kuru', market: 'WETH-USDC', op: 'above', value: 1 }],
          },
        ),
      ),
    ).toMatchObject({ status: 400, body: { reason: 'market_not_allowed' } });

    const replaced = await h.controller.replace(id, { watchers: [BREAKOUT], heartbeatHours: 8 });
    expect(replaced).toMatchObject({ heartbeatSeconds: 28_800, watchers: [{ id: 'breakout' }] });

    expect((await h.controller.remove({ ...id, wid: 'breakout' })).watchers).toEqual([]);
    expect(await httpError(h.controller.remove({ ...id, wid: 'breakout' }))).toMatchObject({
      status: 404,
      body: { reason: 'watcher_not_found' },
    });
  });

  it('is owner-only: another user gets agent_not_found and changes nothing', async () => {
    const h = await harness();
    h.watchers.upsert(h.agent, 'cheap', CHEAP, 'agent');
    h.as('mallory');
    const id = { id: h.agent.id };
    for (const attempt of [
      h.controller.list(id),
      h.controller.upsert({ ...id, wid: 'x' }, CHEAP),
      h.controller.replace(id, { watchers: [] }),
      h.controller.remove({ ...id, wid: 'cheap' }),
    ]) {
      expect(await httpError(attempt)).toMatchObject({
        status: 404,
        body: { reason: 'agent_not_found' },
      });
    }
    expect(h.watchers.view(h.agent.id).watchers.map((w) => w.id)).toEqual(['cheap']);
  });
});
