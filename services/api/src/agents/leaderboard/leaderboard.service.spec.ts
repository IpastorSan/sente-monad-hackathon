/**
 * The leaderboard service (SEN-26): the join, the n < 3 split and the two
 * honest failures, with a fake indexer and the real store and event log.
 *
 * The indexer is faked because it is the one thing here that needs a network;
 * `indexer.spec.ts` covers the client itself, and `metrics.spec.ts` covers the
 * arithmetic. This file is about what the service does with both.
 */
import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { InMemoryAgentEventLog, type AgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore, type AgentRecord, type AgentStore } from '../store/agent-store';
import {
  IndexerQueryError,
  IndexerUnconfiguredError,
  type IndexerAccount,
  type IndexerStats,
} from './indexer';
import { FORMULA, MIN_RANKED_TRADES } from './metrics';
import { LEADERBOARD_NOTES, LeaderboardService } from './leaderboard.service';

const USDC = KURU_TESTNET_TOKENS.USDC.address;
const MARKET = KURU_TESTNET_MARKETS[0]!.address;

/** Two agents, distinguishable by address. */
const NIGHT = '0xAbC0000000000000000000000000000000000001' as Address;
const DAWN = '0xAbC0000000000000000000000000000000000002' as Address;

const MANDATE = {
  version: 1,
  chainId: 10143,
  expiresAt: 4_000_000_000,
  venues: ['kuru'],
  kuru: { markets: [MARKET], maxDepositAtoms: { [USDC]: '1000000000' } },
  perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: [] },
  maxOrderNotional: '250.5',
};

function agent(over: Partial<AgentRecord> & { id: string; address: Address }): AgentRecord {
  const now = new Date('2026-09-17T10:00:00.000Z');
  return {
    userId: 'alice',
    name: `agent ${over.id}`,
    systemPrompt: 'Trade calmly.',
    strategy: 'Mean reversion.',
    model: 'anthropic/claude-sonnet-5',
    mandate: parseMandate(MANDATE),
    walletId: `wallet-${over.id}`,
    policyId: `policy-${over.id}`,
    ownerKind: 'server',
    mcpTokenHash: `hash-${over.id}`,
    status: 'active',
    policyCleared: false,
    public: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function account(over: Partial<IndexerAccount> = {}): IndexerAccount {
  return {
    id: 'kuru-62',
    venue: 'KURU',
    address: NIGHT.toLowerCase(),
    totalTradeCount: 12,
    totalVolumeUsd: '1043.2188',
    realizedPnlUsd: '0',
    winningTradeCount: 0,
    losingTradeCount: 0,
    balances: [],
    ...over,
  };
}

class FakeIndexer implements IndexerStats {
  readonly asked: string[][] = [];

  constructor(private readonly answer: readonly IndexerAccount[] | Error) {}

  accountsFor(addresses: readonly string[]): Promise<IndexerAccount[]> {
    this.asked.push([...addresses]);
    return this.answer instanceof Error
      ? Promise.reject(this.answer)
      : Promise.resolve([...this.answer]);
  }
}

/** A winning, a losing and an open thesis on one agent's trail (SEN-22). */
async function recordTrail(events: AgentEventLog, agentId: string): Promise<void> {
  await events.append({
    agentId,
    runId: 'run-1',
    kind: 'thesis',
    detail: { market: 'MON-USDC', direction: 'long', venue: 'kuru' },
  });
  await events.append({
    agentId,
    runId: 'run-1',
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'MON-USDC',
      side: 'buy',
      filledSize: '10',
      averageFillPrice: '3',
    },
  });
  await events.append({
    agentId,
    runId: 'run-1',
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'MON-USDC',
      side: 'sell',
      filledSize: '10',
      averageFillPrice: '4',
    },
  });
  // A second thesis, short, that lost.
  await events.append({
    agentId,
    runId: 'run-2',
    kind: 'thesis',
    detail: { market: 'WETH-USDC', direction: 'short', venue: 'kuru' },
  });
  await events.append({
    agentId,
    runId: 'run-2',
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'WETH-USDC',
      side: 'sell',
      filledSize: '2',
      averageFillPrice: '5',
    },
  });
  await events.append({
    agentId,
    runId: 'run-2',
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'WETH-USDC',
      side: 'buy',
      filledSize: '2',
      averageFillPrice: '6',
    },
  });
  // A third that has not come back to zero.
  await events.append({
    agentId,
    runId: 'run-3',
    kind: 'thesis',
    detail: { market: 'cbBTC-USDC', direction: 'long', venue: 'kuru' },
  });
  await events.append({
    agentId,
    runId: 'run-3',
    kind: 'fill',
    detail: {
      venue: 'kuru',
      symbol: 'cbBTC-USDC',
      side: 'buy',
      filledSize: '1',
      averageFillPrice: '100',
    },
  });
}

async function setup(options: {
  agents: AgentRecord[];
  accounts?: readonly IndexerAccount[] | Error;
  events?: AgentEventLog;
}) {
  const store: AgentStore = new InMemoryAgentStore();
  for (const record of options.agents) await store.insert(record);
  const events = options.events ?? new InMemoryAgentEventLog();
  const indexer = new FakeIndexer(options.accounts ?? []);
  return { service: new LeaderboardService(store, events, indexer), indexer, events, store };
}

describe('LeaderboardService', () => {
  it('joins the indexer to the agent by wallet address, whatever its case', async () => {
    const { service, indexer } = await setup({
      agents: [agent({ id: 'a', address: NIGHT })],
      accounts: [account({ address: NIGHT.toLowerCase() })],
    });

    const board = await service.leaderboard();

    expect(indexer.asked).toEqual([[NIGHT]]);
    expect(board.source).toEqual({ kind: 'ok' });
    expect(board.ranked).toHaveLength(0);
    expect(board.tooFewTrades).toHaveLength(1);
    expect(board.tooFewTrades[0]).toMatchObject({
      agentId: 'a',
      address: NIGHT,
      indexed: true,
      venues: ['KURU'],
      rank: null,
    });
  });

  it('ranks only n >= 3, numbers the order, and shows the rest as too few trades', async () => {
    const { service } = await setup({
      agents: [
        agent({ id: 'few', address: DAWN }),
        agent({ id: 'ranked', address: NIGHT, name: 'Night desk' }),
      ],
      accounts: [
        // DAWN: one settled trade, a winner — shown, never ordered.
        account({
          id: 'kuru-70',
          address: DAWN.toLowerCase(),
          winningTradeCount: 1,
          losingTradeCount: 0,
          realizedPnlUsd: '9',
          // Raw atoms, as the indexer sends them (SEN-32): 10 USDC.
          balances: [
            { token: USDC, decimals: 6, deposited: '10000000', withdrawn: '0', net: '10000000' },
          ],
        }),
        // NIGHT: 4 settled of 9 fills, 3 of them wins.
        account({
          winningTradeCount: 3,
          losingTradeCount: 1,
          totalTradeCount: 9,
          realizedPnlUsd: '25',
          balances: [
            { token: USDC, decimals: 6, deposited: '100000000', withdrawn: '0', net: '100000000' },
          ],
        }),
      ],
    });

    const board = await service.leaderboard();

    expect(board.ranked.map((row) => [row.rank, row.name, row.n, row.winRate, row.roi])).toEqual([
      [1, 'Night desk', 4, 0.75, 0.25],
    ]);
    expect(board.tooFewTrades.map((row) => [row.rank, row.agentId, row.n, row.winRate])).toEqual([
      [null, 'few', 1, 1],
    ]);
    expect(board.minTrades).toBe(MIN_RANKED_TRADES);
    expect(board.ranked[0]).toMatchObject({
      fills: 9,
      wins: 3,
      losses: 1,
      realisedPnlUsd: '25',
      capitalDeployedUsd: '100',
      mandate: 'Kuru MON-USDC · max 250.5 per order',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('orders the ranked rows by ROI, and passes over the agent with no capital', async () => {
    const { service } = await setup({
      agents: [
        agent({ id: 'a', address: NIGHT, name: 'Aaa' }),
        agent({ id: 'b', address: DAWN, name: 'Bbb' }),
      ],
      accounts: [
        account({
          address: NIGHT.toLowerCase(),
          winningTradeCount: 4,
          losingTradeCount: 0,
          realizedPnlUsd: '10',
          balances: [
            { token: USDC, decimals: 6, deposited: '100000000', withdrawn: '0', net: '100000000' },
          ],
        }),
        // Same record, but nothing was deposited — no capital to divide by.
        account({
          id: 'kuru-70',
          address: DAWN.toLowerCase(),
          winningTradeCount: 4,
          losingTradeCount: 0,
        }),
      ],
    });

    const board = await service.leaderboard();

    expect(board.ranked.map((row) => [row.name, row.roi])).toEqual([
      ['Aaa', 0.1],
      ['Bbb', null],
    ]);
  });

  it('adds the SEN-22 reading: theses settled, held and still open', async () => {
    const events = new InMemoryAgentEventLog();
    await recordTrail(events, 'a');
    const { service } = await setup({
      agents: [agent({ id: 'a', address: NIGHT })],
      accounts: [account({ address: NIGHT.toLowerCase() })],
      events,
    });

    const board = await service.leaderboard();

    expect(board.tooFewTrades[0]!.theses).toEqual({ settled: 2, held: 1, open: 1 });
  });

  it('leaves revoked agents off the board: their mandate is empty', async () => {
    const { service, indexer } = await setup({
      agents: [
        agent({ id: 'gone', address: DAWN, status: 'revoked' }),
        agent({ id: 'live', address: NIGHT }),
      ],
      accounts: [account({ address: NIGHT.toLowerCase() })],
    });

    const board = await service.leaderboard();

    expect(indexer.asked).toEqual([[NIGHT]]);
    expect([...board.ranked, ...board.tooFewTrades].map((row) => row.agentId)).toEqual(['live']);
  });

  it('publishes the formula, the notes and the minimum sample on every answer', async () => {
    const { service } = await setup({ agents: [agent({ id: 'a', address: NIGHT })] });

    const board = await service.leaderboard();

    expect(board.formula).toBe(FORMULA);
    expect(board.notes).toEqual([...LEADERBOARD_NOTES]);
    expect(board.formula).toContain('n = settled trades');
    expect(board.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers unconfigured — empty and explicit — rather than ranking nothing', async () => {
    const { service } = await setup({
      agents: [agent({ id: 'a', address: NIGHT })],
      accounts: new IndexerUnconfiguredError('ENVIO_GRAPHQL_URL is not set'),
    });

    const board = await service.leaderboard();

    expect(board.ranked).toEqual([]);
    expect(board.tooFewTrades).toEqual([]);
    expect(board.source).toMatchObject({ kind: 'unconfigured' });
    expect(board.source.message).toContain('ENVIO_GRAPHQL_URL');
    // The definitions still ship: the route answers, honestly, whatever the
    // board's state.
    expect(board.formula).toBe(FORMULA);
    expect(board.notes).toContain(board.source.message);
  });

  it('answers unreachable rather than showing rows it cannot verify', async () => {
    const { service } = await setup({
      agents: [agent({ id: 'a', address: NIGHT })],
      accounts: new IndexerQueryError('the indexer answered 503'),
    });

    const board = await service.leaderboard();

    expect(board.ranked).toEqual([]);
    expect(board.tooFewTrades).toEqual([]);
    expect(board.source).toMatchObject({ kind: 'unreachable' });
    expect(board.source.message).toContain('answered 503');
  });

  it('lets anything that is not the indexer\u2019s fault through', async () => {
    const { service } = await setup({
      agents: [agent({ id: 'a', address: NIGHT })],
      accounts: new RangeError('a bug in the join'),
    });

    await expect(service.leaderboard()).rejects.toThrow('a bug in the join');
  });
});
