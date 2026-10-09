import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { InMemoryAgentEventLog, type AgentEvent } from '../events/agent-event-log';
import { fifoCostBasis } from '../portfolio/cost-basis';
import { KeyedMutex } from '../tools/keyed-mutex';
import { MON_USDC, MON_USDC_BOOK, testAgent } from '../tools/testing/agent-fixture';
import { kuruFillSource } from './resting-fill.providers';
import {
  loadRestingFillConfig,
  RESTING_FILL_DEFAULTS,
  RestingFillWatcher,
  type RestingFillConfig,
} from './resting-fill.watcher';

/**
 * The watcher end to end against the real adapter path: a fake public client
 * serves `TradesPacked` logs, `KuruVenue.makerFills` decodes them with the
 * SDK, and the watcher appends to a real in-memory log.
 *
 * The first fixture is REAL: the packed trade record of tx 0x9d7fbce1… on
 * Monad testnet (block 61406913, docs/kuru.md), where account 62's IOC swept
 * account 47's resting ask `1:3679` — 317.73742494 MON at 0.030974 on that Set-C book
 * (31773.742494 MON read at today's MON-USDC size precision, SEN-185), maker fee
 * 4000 pps. Here account 47 is our agent, so that sweep is a later fill of an
 * order the agent rested earlier.
 */
const REAL_RECORD: Hex =
  '0x000000002f0104000078fe000000000000000765dcd59e0000000000000e5f00000000000000000000000000000fa00000000000000000000000000000000062';
const REAL_TX: Hex = '0x9d7fbce17b32fb4585612ed292ba064da5e85c0da865edee6dcfb2aefb2d30fd';
const REAL_BLOCK = 61_406_913n;
const MAKER = 47n;
const TAKER = 62n;

interface Trade {
  makerId: bigint;
  slotIdx: number;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  orderId: bigint;
  remaining: bigint;
  makerFeePps: bigint;
  tradeId: bigint;
}

/** One 64-byte `TradesPacked` record, in the layout the SDK decodes. */
function packTrade(t: Trade): string {
  const flags = BigInt((t.isBuy ? 1 : 0) | 4);
  const first =
    (t.makerId << 216n) |
    (BigInt(t.slotIdx) << 208n) |
    (flags << 200n) |
    (t.price << 168n) |
    (t.size << 72n) |
    (t.orderId << 8n);
  const second = (t.remaining << 160n) | (t.makerFeePps << 136n) | t.tradeId;
  return toHex(first, { size: 32 }).slice(2) + toHex(second, { size: 32 }).slice(2);
}

const TRADES_PACKED = getAbiItem({ abi: kuruAbi.orderBookAbi, name: 'TradesPacked' });
const EXECUTOR: Address = `0x${'6'.repeat(40)}`;

interface ChainLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
}

function tradesLog(
  records: string,
  at: { tx: Hex; logIndex: number; block: bigint; market?: Address },
): ChainLog {
  return {
    address: at.market ?? MON_USDC_BOOK,
    topics: encodeEventTopics({
      abi: [TRADES_PACKED],
      eventName: 'TradesPacked',
      args: { accountId: Number(TAKER), executor: EXECUTOR },
    }) as Hex[],
    data: encodeAbiParameters(
      TRADES_PACKED.inputs.filter((input) => !input.indexed),
      [zeroHash, 7000, zeroAddress, 0, `0x${records}`],
    ),
    transactionHash: at.tx,
    logIndex: at.logIndex,
    blockNumber: at.block,
  };
}

/** A Monad stand-in: a head, a log store `getLogs` filters by range, and account 47 for us. */
function fakeChain(head: bigint) {
  const state = { head, logs: [] as ChainLog[], failNext: 0 };
  const getLogs = jest.fn(
    async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]> => {
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error('rpc: block range too large');
      }
      return state.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  );
  const chain = Object.assign(state, { getLogs });
  const client = {
    getBlockNumber: async () => chain.head,
    getLogs: chain.getLogs,
    readContract: async () => MAKER,
  } as unknown as PublicClient;
  return { chain, client };
}

const agent = testAgent();
const CONFIG: RestingFillConfig = { ...RESTING_FILL_DEFAULTS, pollSeconds: undefined };

async function seed(log: InMemoryAgentEventLog, events: Omit<AgentEvent, 'seq' | 'at'>[]) {
  for (const event of events) await log.append(event);
}

const thesis: Omit<AgentEvent, 'seq' | 'at'> = {
  agentId: agent.id,
  runId: 'run-1',
  kind: 'thesis',
  tool: 'record_thesis',
  detail: { market: MON_USDC, direction: 'long', thesis: 'Range break.', invalidation: 'Back in.' },
};

/** The IOC buy that opened the position, as the gate records it. */
const entryFill: Omit<AgentEvent, 'seq' | 'at'> = {
  agentId: agent.id,
  runId: 'run-1',
  kind: 'fill',
  tool: 'place_market',
  detail: {
    orderId: '0xabc',
    venue: 'kuru',
    symbol: MON_USDC,
    side: 'buy',
    type: 'market',
    status: 'filled',
    filledSize: '31773.742494',
    averageFillPrice: '0.03',
    txHash: '0xabc',
    blockNumber: 61_406_000,
    fee: '0.006672',
    feeAsset: 'USDC',
  },
};

/** The resting ask the later fill takes, as the gate records a `place_limit` that rested. */
function restingAsk(
  over: { id?: string; size?: string; status?: string; filled?: string; block?: number } = {},
): Omit<AgentEvent, 'seq' | 'at'> {
  return {
    agentId: agent.id,
    runId: 'run-2',
    kind: 'order',
    tool: 'place_limit',
    detail: {
      status: 'ok',
      precheck: true,
      args: {
        venue: 'kuru',
        market: MON_USDC,
        side: 'sell',
        size: '31773.742494',
        price: '0.030974',
      },
      intent: { venue: 'kuru', kind: 'order', market: MON_USDC_BOOK },
      result: {
        id: over.id ?? '1:3679',
        symbol: MON_USDC,
        side: 'sell',
        type: 'limit',
        status: over.status ?? 'open',
        price: '0.030974',
        size: over.size ?? '31773.742494',
        filledSize: over.filled ?? '0',
        txHash: '0xdef',
        blockNumber: over.block ?? 61_406_900,
      },
    },
  };
}

function watcher(log: InMemoryAgentEventLog, client: PublicClient, now = () => 1_000) {
  return new RestingFillWatcher({
    config: CONFIG,
    store: { listAll: async () => [agent] },
    events: log,
    source: kuruFillSource(client),
    writeLock: new KeyedMutex(),
    now,
    logger: { warn: jest.fn(), error: jest.fn() },
  });
}

const fillsOf = async (log: InMemoryAgentEventLog) =>
  (await log.list(agent.id, { kind: 'fill' })).filter((e) => e.detail['source'] === 'resting');

describe('packTrade', () => {
  it('reproduces the real record byte for byte', () => {
    expect(
      `0x${packTrade({
        makerId: MAKER,
        slotIdx: 1,
        isBuy: false,
        price: 30_974n,
        size: 31_773_742_494n,
        orderId: 3679n,
        remaining: 0n,
        makerFeePps: 4000n,
        tradeId: 98n,
      })}`,
    ).toBe(REAL_RECORD);
  });
});

describe('RestingFillWatcher (SEN-149)', () => {
  it('records a resting order that fills later exactly once, then settles its thesis', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk()]);
    const { chain, client } = fakeChain(REAL_BLOCK + 10n);
    chain.logs.push(
      tradesLog(REAL_RECORD.slice(2), { tx: REAL_TX, logIndex: 4, block: REAL_BLOCK }),
    );

    await expect(watcher(log, client).poll()).resolves.toEqual({ watched: 1, recorded: 1 });

    const [fill, ...rest] = await fillsOf(log);
    expect(rest).toEqual([]);
    expect(fill).toMatchObject({
      kind: 'fill',
      tool: 'place_limit',
      detail: {
        orderId: '1:3679',
        venue: 'kuru',
        symbol: MON_USDC,
        side: 'sell',
        status: 'filled',
        // The REAL bytes are Set C's, where they meant 317.73742494 MON at a
        // 10^8 size precision; on today's MON-USDC book (10^6, SEN-185) the
        // same record reads 100× the size. The decode path is what is tested.
        filledSize: '31773.742494',
        averageFillPrice: '0.030974',
        // The record's own maker rate, 4000 pps of 984.159998 USDC, floored at the atom.
        fee: '0.393663',
        feeAsset: 'USDC',
        remainingSize: '0',
        txHash: REAL_TX,
        blockNumber: Number(REAL_BLOCK),
        tradeKey: `kuru:${REAL_TX}:4:0`,
        tradeId: '98',
      },
    });
    expect(fill!.runId).toBeUndefined();

    // The position is flat again: the cost basis has both legs, and the thesis
    // behind them got the verdict a placement fill would have produced.
    const events = await log.list(agent.id);
    const basis = fifoCostBasis(events, MON_USDC, await log.truncation(agent.id));
    expect(basis).toMatchObject({ fills: 2, openSize: '0', unmatchedSellSize: '0' });
    const verdicts = events.filter((e) => e.kind === 'verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.detail).toMatchObject({
      market: MON_USDC,
      held: true,
      fills: 2,
      blockNumber: Number(REAL_BLOCK),
    });
    expect(events.at(-1)!.kind).toBe('verdict');
  });

  it('re-polling and restarting record nothing twice', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk()]);
    const { chain, client } = fakeChain(REAL_BLOCK + 10n);
    chain.logs.push(
      tradesLog(REAL_RECORD.slice(2), { tx: REAL_TX, logIndex: 4, block: REAL_BLOCK }),
    );

    const first = watcher(log, client);
    await first.poll();
    // The order is filled: a re-poll watches nothing and reads no chain.
    chain.getLogs.mockClear();
    await expect(first.poll()).resolves.toEqual({ watched: 0, recorded: 0 });
    expect(chain.getLogs).not.toHaveBeenCalled();

    // A fresh process over the same log (the file log reloads it): same answer.
    await expect(watcher(log, client).poll()).resolves.toEqual({ watched: 0, recorded: 0 });
    expect(await fillsOf(log)).toHaveLength(1);
    expect((await log.list(agent.id)).filter((e) => e.kind === 'verdict')).toHaveLength(1);
  });

  it('records partial fills one by one, across polls and a restart, and stops when none is left', async () => {
    const log = new InMemoryAgentEventLog();
    // 10 MON asked at 0.031; 2 filled when it was placed, 8 rest.
    await seed(log, [
      thesis,
      restingAsk({ id: '2:4000', size: '10', status: 'partially_filled', filled: '2', block: 100 }),
      {
        agentId: agent.id,
        runId: 'run-2',
        kind: 'fill',
        tool: 'place_limit',
        detail: {
          orderId: '2:4000',
          venue: 'kuru',
          symbol: MON_USDC,
          side: 'sell',
          status: 'partially_filled',
          filledSize: '2',
          averageFillPrice: '0.031',
          blockNumber: 100,
        },
      },
    ]);
    const trade = (size: bigint, remaining: bigint, tradeId: bigint) =>
      packTrade({
        makerId: MAKER,
        slotIdx: 2,
        isBuy: false,
        price: 31_000n,
        size: size * 10n ** 6n,
        orderId: 4000n,
        remaining: remaining * 10n ** 6n,
        makerFeePps: 4000n,
        tradeId,
      });
    const someoneElse = packTrade({
      makerId: 99n,
      slotIdx: 2,
      isBuy: false,
      price: 31_000n,
      size: 10n ** 6n,
      orderId: 4000n,
      remaining: 0n,
      makerFeePps: 4000n,
      tradeId: 7n,
    });
    const { chain, client } = fakeChain(250n);
    // One sweep hits another maker and then us (record 1), in block 150.
    chain.logs.push(
      tradesLog(someoneElse + trade(3n, 5n, 8n), { tx: '0x01', logIndex: 0, block: 150n }),
    );

    let now = 1_000;
    const first = watcher(log, client, () => now);
    await expect(first.poll()).resolves.toEqual({ watched: 1, recorded: 1 });

    // Two more fills land later, the second in the same block as the first.
    chain.head = 400n;
    chain.logs.push(tradesLog(trade(1n, 4n, 9n), { tx: '0x02', logIndex: 3, block: 300n }));
    now = 2_000;
    await expect(first.poll()).resolves.toEqual({ watched: 1, recorded: 1 });

    // Restart: the cursor comes back from the last recorded fill (block 300,
    // inclusive), so this one — same block, next log — is not skipped.
    chain.head = 500n;
    chain.logs.push(tradesLog(trade(4n, 0n, 10n), { tx: '0x03', logIndex: 9, block: 300n }));
    await expect(watcher(log, client).poll()).resolves.toEqual({ watched: 1, recorded: 1 });

    const fills = await fillsOf(log);
    expect(
      fills.map((f) => [f.detail['filledSize'], f.detail['remainingSize'], f.detail['status']]),
    ).toEqual([
      ['3', '5', 'partially_filled'],
      ['1', '4', 'partially_filled'],
      ['4', '0', 'filled'],
    ]);
    expect(fills[0]!.detail['tradeKey']).toBe('kuru:0x01:0:1');
    // 3 MON × 0.031 = 0.093 USDC at 4000 pps.
    expect(fills[0]!.detail['fee']).toBe('0.000037');
    await expect(watcher(log, client).poll()).resolves.toEqual({ watched: 0, recorded: 0 });
  });

  it('keeps its place when a log read fails, and records the fill on the next poll', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk()]);
    const { chain, client } = fakeChain(REAL_BLOCK + 10n);
    chain.logs.push(
      tradesLog(REAL_RECORD.slice(2), { tx: REAL_TX, logIndex: 4, block: REAL_BLOCK }),
    );
    chain.failNext = 1;
    const w = watcher(log, client);
    await expect(w.poll()).resolves.toEqual({ watched: 1, recorded: 0 });
    await expect(w.poll()).resolves.toEqual({ watched: 1, recorded: 1 });
    expect(await fillsOf(log)).toHaveLength(1);
  });

  it('reads in capped ranges and spreads a long catch-up over polls', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk({ block: 1_000 })]);
    const { chain, client } = fakeChain(1_000n + 100n * 40n - 1n + 3n);
    const w = watcher(log, client);
    await w.poll();
    expect(chain.getLogs).toHaveBeenCalledTimes(RESTING_FILL_DEFAULTS.maxRangesPerPoll);
    for (const [args] of chain.getLogs.mock.calls) {
      expect(args.toBlock - args.fromBlock).toBeLessThan(100n);
    }
    expect(chain.getLogs.mock.calls[0]![0]).toMatchObject({ fromBlock: 1_000n, toBlock: 1_099n });
    chain.getLogs.mockClear();
    await w.poll();
    expect(chain.getLogs).toHaveBeenCalledTimes(10);
    // Up to the head less 3 confirmations.
    expect(chain.getLogs.mock.calls.at(-1)![0].toBlock).toBe(1_000n + 100n * 40n - 1n);
  });

  it('watches a cancelled order until it has read past the cancel, then lets it go', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk()]);
    await log.append({
      agentId: agent.id,
      runId: 'run-3',
      kind: 'order',
      tool: 'cancel_order',
      at: 1_500,
      detail: {
        status: 'ok',
        args: { venue: 'kuru', market: MON_USDC, orderId: '1:3679' },
        result: { id: '1:3679', status: 'filled' },
      },
    });
    const { chain, client } = fakeChain(REAL_BLOCK + 10n);
    // The fill landed before the cancel did: it still has to be recorded.
    chain.logs.push(
      tradesLog(REAL_RECORD.slice(2), { tx: REAL_TX, logIndex: 4, block: REAL_BLOCK }),
    );
    const w = watcher(log, client, () => 2_000);
    await expect(w.poll()).resolves.toEqual({ watched: 1, recorded: 1 });
  });

  it('lets a cancelled order go once a head seen after the cancel is read', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill, restingAsk({ block: 100 })]);
    await log.append({
      agentId: agent.id,
      kind: 'order',
      tool: 'cancel_order',
      at: 1_500,
      detail: {
        status: 'ok',
        args: { venue: 'kuru', market: MON_USDC, orderId: '1:3679' },
        result: {},
      },
    });
    const { chain, client } = fakeChain(200n);
    let now = 2_000;
    const w = watcher(log, client, () => now);
    // Head 200 seen after the cancel; read to 197 (3 confirmations): not past it yet.
    await expect(w.poll()).resolves.toMatchObject({ watched: 1 });
    chain.head = 210n;
    now = 3_000;
    await expect(w.poll()).resolves.toMatchObject({ watched: 1 });
    // Read to 207 ≥ 200: the order is done.
    await expect(w.poll()).resolves.toEqual({ watched: 0, recorded: 0 });
  });

  it('touches no chain for an agent without resting orders', async () => {
    const log = new InMemoryAgentEventLog();
    await seed(log, [thesis, entryFill]);
    const { chain, client } = fakeChain(100n);
    await expect(watcher(log, client).poll()).resolves.toEqual({ watched: 0, recorded: 0 });
    expect(chain.getLogs).not.toHaveBeenCalled();
  });
});

describe('loadRestingFillConfig', () => {
  it('defaults to 15 s and 100-block ranges, turns off, and refuses nonsense', () => {
    expect(loadRestingFillConfig({})).toMatchObject({ pollSeconds: 15, maxBlockRange: 100n });
    expect(loadRestingFillConfig({ AGENT_FILL_POLL_SECONDS: 'off' }).pollSeconds).toBeUndefined();
    expect(loadRestingFillConfig({ AGENT_FILL_MAX_BLOCK_RANGE: '1000' }).maxBlockRange).toBe(1000n);
    expect(() => loadRestingFillConfig({ AGENT_FILL_POLL_SECONDS: '1' })).toThrow(/5 to 300/);
  });
});
