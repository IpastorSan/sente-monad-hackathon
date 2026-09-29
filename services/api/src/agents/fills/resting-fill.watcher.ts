/**
 * Records later fills of agents' resting Kuru orders (SEN-149).
 *
 * Every poll:
 *
 * 1. Each agent's log says which of its Kuru orders may still fill
 *    (`restingKuruOrders`). Agents with none cost one in-memory log read and
 *    nothing on chain.
 * 2. Each market with a watched order is read ONCE for maker fills
 *    (`KuruVenue.makerFills`, the OrderBook's `TradesPacked` logs), from the
 *    oldest watched order's cursor up to the chain head less a few
 *    confirmations, in ranges no wider than the RPC's `eth_getLogs` cap and at
 *    most `maxRangesPerPoll` of them, so catching up on an old order spreads
 *    over polls instead of stalling one. Markets are read at most
 *    `maxConcurrent` at a time, and a poll never overlaps the previous one.
 * 3. Every fill whose maker is a watched order's account, slot and id becomes
 *    one `fill` event, appended under the agent's write lock (the gate's), and
 *    then asks `recordVerdictFor` exactly as a placement fill does.
 *
 * IDEMPOTENT by construction, not by bookkeeping: each fill carries a
 * `tradeKey` (transaction, log index, record index) and is appended only when
 * no event on the agent's log already has that key, checked under the lock.
 * Cursors live in memory; after a restart an order is re-read from its last
 * recorded later fill (else its placement block), and whatever is read twice
 * is skipped by its key. A re-poll after a failed range read likewise
 * re-reads from where it stopped.
 *
 * A cancelled order stays watched until the watcher has read past the head it
 * saw after the cancel landed: a fill can land between the previous read and
 * the cancel, and would otherwise never be recorded.
 */
import { Logger } from '@nestjs/common';
import type { MakerFill } from '@sente/venues/kuru';
import type { Address } from 'viem';

import type { AgentEventLog } from '../events/agent-event-log';
import { recordVerdictFor } from '../events/settle-fill';
import type { AgentRecord, AgentStore } from '../store/agent-store';
import type { KeyedMutex } from '../tools/keyed-mutex';
import { laterFillEvent, restingKuruOrders, tradeKeyOf, type RestingOrder } from './resting-orders';

/** DI token for the resolved watcher configuration. */
export const RESTING_FILL_CONFIG = Symbol('RESTING_FILL_CONFIG');

/** What the watcher reads the chain through. `KuruVenue` in production. */
export interface KuruFillSource {
  /** The chain head's block number. */
  head(): Promise<bigint>;
  /** Maker fills on `symbol`'s book in `fromBlock..toBlock`, inclusive. */
  makerFills(symbol: string, fromBlock: bigint, toBlock: bigint): Promise<MakerFill[]>;
  /** The AccountCore id of `address`; `0n` when it never deposited. */
  accountId(address: Address): Promise<bigint>;
}

export interface RestingFillConfig {
  /** `undefined` = the watcher is off. */
  readonly pollSeconds: number | undefined;
  /** Widest `eth_getLogs` range: Monad's public RPC caps it at 100 blocks. */
  readonly maxBlockRange: bigint;
  /** Range reads per market per poll, so a long catch-up spreads over polls. */
  readonly maxRangesPerPoll: number;
  /** Markets read at once. */
  readonly maxConcurrent: number;
  /** Blocks below the head left unread, so a fill is recorded once it cannot be reorged away. */
  readonly confirmations: bigint;
  /** Where an order whose placement named no block is read from, back from the head. */
  readonly lookbackBlocks: bigint;
}

export const RESTING_FILL_DEFAULTS = {
  pollSeconds: 15,
  maxBlockRange: 100n,
  maxRangesPerPoll: 30,
  maxConcurrent: 2,
  confirmations: 3n,
  lookbackBlocks: 1_000n,
} as const;

/**
 * Pure env -> config. `AGENT_FILL_POLL_SECONDS`: default 15, 5..300; `0` or
 * `off` turns the watcher off. `AGENT_FILL_MAX_BLOCK_RANGE`: default 100, for an
 * RPC with a wider `eth_getLogs` cap.
 */
export function loadRestingFillConfig(env: NodeJS.ProcessEnv = process.env): RestingFillConfig {
  const raw = env['AGENT_FILL_POLL_SECONDS']?.trim().toLowerCase();
  const pollSeconds =
    raw === '0' || raw === 'off'
      ? undefined
      : integer(raw, 'AGENT_FILL_POLL_SECONDS', RESTING_FILL_DEFAULTS.pollSeconds, 5, 300);
  const range = integer(
    env['AGENT_FILL_MAX_BLOCK_RANGE']?.trim(),
    'AGENT_FILL_MAX_BLOCK_RANGE',
    Number(RESTING_FILL_DEFAULTS.maxBlockRange),
    1,
    10_000,
  );
  return { ...RESTING_FILL_DEFAULTS, pollSeconds, maxBlockRange: BigInt(range) };
}

function integer(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}; got "${raw}"`);
  }
  return Number(raw);
}

export interface RestingFillWatcherOptions {
  readonly config: RestingFillConfig;
  readonly store: Pick<AgentStore, 'listAll'>;
  readonly events: AgentEventLog;
  readonly source: KuruFillSource;
  /** The gate's per-agent write lock, so a fill and a placement never interleave. */
  readonly writeLock: KeyedMutex;
  readonly now?: () => number;
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
}

/** What one poll did, for specs and logs. */
export interface RestingFillPoll {
  readonly watched: number;
  readonly recorded: number;
}

interface Watched {
  readonly order: RestingOrder;
  readonly accountId: bigint;
}

/** A head the watcher saw, and when: how a cancel is known to be read past. */
interface HeadSighting {
  readonly at: number;
  readonly block: bigint;
}

const MAX_SIGHTINGS = 64;

export class RestingFillWatcher {
  readonly #options: RestingFillWatcherOptions;
  readonly #now: () => number;
  readonly #logger: Pick<Logger, 'warn' | 'error'>;
  /** Next block to read, per watched order. */
  readonly #cursors = new Map<string, bigint>();
  /** Highest block read, per market. */
  readonly #readTo = new Map<string, bigint>();
  readonly #heads: HeadSighting[] = [];
  /** AccountCore ids by address; only real (non-zero) ones, which never change. */
  readonly #accounts = new Map<string, bigint>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<RestingFillPoll> | undefined;

  constructor(options: RestingFillWatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? new Logger(RestingFillWatcher.name);
  }

  /** Nest lifecycle hook. */
  onApplicationBootstrap(): void {
    this.start();
  }

  /** Nest lifecycle hook. */
  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    const seconds = this.#options.config.pollSeconds;
    if (seconds === undefined || this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.poll(), seconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Joins a poll already running rather than starting a second. Never throws. */
  poll(): Promise<RestingFillPoll> {
    this.#polling ??= this.#poll()
      .catch((error: unknown) => {
        this.#logger.error(`poll failed: ${String(error)}`);
        return { watched: 0, recorded: 0 };
      })
      .finally(() => {
        this.#polling = undefined;
      });
    return this.#polling;
  }

  async #poll(): Promise<RestingFillPoll> {
    const watched = await this.#watched();
    const live = new Set(watched.map(({ order }) => orderKey(order)));
    for (const key of this.#cursors.keys()) if (!live.has(key)) this.#cursors.delete(key);
    if (watched.length === 0) return { watched: 0, recorded: 0 };

    const readAt = this.#now();
    const head = await this.#options.source.head();
    this.#heads.push({ at: readAt, block: head });
    if (this.#heads.length > MAX_SIGHTINGS) this.#heads.shift();
    const safeHead = head - this.#options.config.confirmations;

    const byMarket = new Map<string, Watched[]>();
    for (const entry of watched) {
      const list = byMarket.get(entry.order.symbol) ?? [];
      list.push(entry);
      byMarket.set(entry.order.symbol, list);
    }
    const found = await limit(this.#options.config.maxConcurrent, [...byMarket], ([symbol, list]) =>
      this.#readMarket(symbol, list, safeHead),
    );

    let recorded = 0;
    const byAgent = new Map<string, { order: RestingOrder; fill: MakerFill }[]>();
    for (const match of found.flat()) {
      const list = byAgent.get(match.order.agentId) ?? [];
      list.push(match);
      byAgent.set(match.order.agentId, list);
    }
    for (const [agentId, matches] of byAgent) {
      recorded += await this.#options.writeLock.run(agentId, () => this.#record(agentId, matches));
    }
    return { watched: watched.length, recorded };
  }

  /** Every order that may still fill, with its account id, cancelled ones read past dropped. */
  async #watched(): Promise<Watched[]> {
    const agents = await this.#options.store.listAll();
    const out: Watched[] = [];
    for (const agent of agents) {
      const { open } = restingKuruOrders(await this.#options.events.list(agent.id));
      const orders = open.filter((order) => !this.#readPastCancel(order));
      if (orders.length === 0) continue;
      const accountId = await this.#accountId(agent);
      if (accountId === 0n) continue;
      for (const order of orders) out.push({ order, accountId });
    }
    return out;
  }

  /** Read one market for every order watched on it; the fills that are theirs. */
  async #readMarket(
    symbol: string,
    list: readonly Watched[],
    safeHead: bigint,
  ): Promise<{ order: RestingOrder; fill: MakerFill }[]> {
    const { maxBlockRange, maxRangesPerPoll, lookbackBlocks } = this.#options.config;
    let from: bigint | undefined;
    for (const { order } of list) {
      const cursor = this.#cursorOf(order, safeHead, lookbackBlocks);
      if (from === undefined || cursor < from) from = cursor;
    }
    if (from === undefined || from > safeHead) return [];

    const owners = new Map(
      list.map((entry) => [makerKey(entry.accountId, entry.order.orderId), entry.order]),
    );
    const matches: { order: RestingOrder; fill: MakerFill }[] = [];
    let readTo = from - 1n;
    for (let ranges = 0; ranges < maxRangesPerPoll && readTo < safeHead; ranges++) {
      const start = readTo + 1n;
      const end = min(start + maxBlockRange - 1n, safeHead);
      let fills: MakerFill[];
      try {
        fills = await this.#options.source.makerFills(symbol, start, end);
      } catch (error) {
        // Stop here and keep what was read: the next poll resumes at `start`.
        this.#logger.warn(`${symbol}: could not read blocks ${start}..${end}: ${String(error)}`);
        break;
      }
      for (const fill of fills) {
        const order = owners.get(makerKey(fill.makerId, fill.orderId));
        if (order) matches.push({ order, fill });
      }
      readTo = end;
    }

    for (const { order } of list) {
      const key = orderKey(order);
      if ((this.#cursors.get(key) ?? 0n) <= readTo) this.#cursors.set(key, readTo + 1n);
    }
    if (readTo > (this.#readTo.get(symbol) ?? -1n)) this.#readTo.set(symbol, readTo);
    return matches;
  }

  /** Append the fills the log does not already hold, oldest first, each followed by its verdict. */
  async #record(
    agentId: string,
    matches: readonly { order: RestingOrder; fill: MakerFill }[],
  ): Promise<number> {
    const { events } = this.#options;
    let recorded = 0;
    try {
      // Re-read under the lock: this is the check that makes a re-poll, a
      // restart or an overlapping read record nothing twice.
      const { recorded: seen } = restingKuruOrders(await events.list(agentId));
      const keys = new Set(seen);
      const ordered = [...matches].sort((a, b) => compareFills(a.fill, b.fill));
      for (const { order, fill } of ordered) {
        const key = tradeKeyOf(fill);
        if (keys.has(key)) continue;
        const stored = await events.append(laterFillEvent(order, fill));
        keys.add(key);
        recorded++;
        await recordVerdictFor(events, { agentId, tool: order.tool }, stored.detail);
      }
    } catch (error) {
      // Nothing is lost: an unrecorded fill is read again from the cursor
      // kept by its last recorded fill after a restart, and skipped by its key.
      this.#logger.error(`could not record later fills for agent ${agentId}: ${String(error)}`);
    }
    return recorded;
  }

  #cursorOf(order: RestingOrder, safeHead: bigint, lookback: bigint): bigint {
    const key = orderKey(order);
    let cursor = this.#cursors.get(key);
    if (cursor === undefined) {
      if (order.fromBlock === undefined) {
        this.#logger.warn(
          `${order.agentId} ${order.symbol} ${order.orderId}: placement named no block; ` +
            `reading the last ${lookback} blocks`,
        );
      }
      cursor = order.fromBlock ?? max(safeHead - lookback, 0n);
      this.#cursors.set(key, cursor);
    }
    return cursor;
  }

  /** A cancelled order is done once a head seen after its cancel has been read up to. */
  #readPastCancel(order: RestingOrder): boolean {
    if (order.cancelledAt === undefined) return false;
    const readTo = this.#readTo.get(order.symbol);
    if (readTo === undefined) return false;
    return this.#heads.some((seen) => seen.at >= order.cancelledAt! && seen.block <= readTo);
  }

  async #accountId(agent: AgentRecord): Promise<bigint> {
    const key = agent.address.toLowerCase();
    const known = this.#accounts.get(key);
    if (known !== undefined) return known;
    try {
      const id = await this.#options.source.accountId(agent.address);
      if (id !== 0n) this.#accounts.set(key, id);
      return id;
    } catch (error) {
      this.#logger.warn(`could not read ${agent.id}'s Kuru account id: ${String(error)}`);
      return 0n;
    }
  }
}

function orderKey(order: RestingOrder): string {
  return `${order.agentId}|${order.symbol}|${order.orderId}`;
}

/** An order on one account's book: its account id and Sente's `"<slot>:<id>"`. */
function makerKey(accountId: bigint, orderId: string): string {
  return `${accountId}|${orderId}`;
}

function compareFills(a: MakerFill, b: MakerFill): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
  return a.recordIndex - b.recordIndex;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** `task` over `items`, at most `concurrency` at a time, results in order. */
async function limit<T, R>(
  concurrency: number,
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
