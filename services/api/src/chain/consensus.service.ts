/**
 * Monad's commit state per block, followed live and exposed to the rest of the
 * API (SEN-21).
 *
 * A Monad block passes through four states — `Proposed` → `Voted` →
 * `Finalized` → `Verified` — and the public WebSocket pushes every move of
 * every block as a `monadNewHeads` notification. Watching that is what lets
 * the Agent Ledger's consensus ramp show real progress for a trade instead of
 * a spinner: an order's `blockNumber` is in the SEN-20 event detail, and this
 * service is the thing that can say "that block is Finalized", with the
 * millisecond offsets between its states.
 *
 * Measured on Monad testnet, 2026-09-13 (docs/agents.md):
 * `Proposed` +0 ms → `Voted` +216 ms → `Finalized` +510 ms → `Verified` ≈ +1 s.
 * A block may skip `Voted` entirely, so the state is a *set* of observations,
 * not a step counter — `at` carries the timestamp of each state seen.
 *
 * Two sources, one map:
 *
 *   1. `eth_subscribe(["monadNewHeads"])` on `MONAD_WS_URL` — the real thing,
 *      and the only source that can report `Verified`.
 *   2. While the socket is down, `eth_getBlockByNumber` with the `latest` /
 *      `safe` / `finalized` tags, every `pollIntervalMs`. Those map to
 *      `Proposed` / `Voted` / `Finalized`. `Verified` is simply unobservable
 *      over HTTP and is never invented.
 *
 * The two sources do not name a block the same way — the socket reports Monad's
 * consensus `blockId`, `eth_getBlockByNumber` reports the execution hash — so a
 * record keeps both under their own names and a reorg is only ever decided
 * between two ids from the SAME source (SEN-35). Comparing across them made
 * every socket flap look like a reorg.
 *
 * Erasable syntax only and no Nest imports: `scripts/consensus-watch.ts` loads
 * this file under node's type stripping (CLAUDE.md gotcha 10). The Nest wiring
 * lives in `chain.module.ts`.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** The four states a Monad block passes through, in commit order. */
export const COMMIT_STATES = ['Proposed', 'Voted', 'Finalized', 'Verified'] as const;
export type CommitState = (typeof COMMIT_STATES)[number];

/** Where each state sits in that order. `Verified` is the end of the line. */
const STATE_RANK: Record<CommitState, number> = {
  Proposed: 0,
  Voted: 1,
  Finalized: 2,
  Verified: 3,
};

/** `at` keys: the state names lowercased, as the API and the mobile ramp spell them. */
export type CommitTimeKey = Lowercase<CommitState>;

const STATE_KEYS: Record<CommitState, CommitTimeKey> = {
  Proposed: 'proposed',
  Voted: 'voted',
  Finalized: 'finalized',
  Verified: 'verified',
};

/**
 * A fresh `at` map holding one observation. Built by assignment rather than a
 * computed key literal, which TypeScript widens to a `string` index signature.
 */
function commitTimes(state: CommitState, at: number): CommitTimes {
  const times: CommitTimes = {};
  times[STATE_KEYS[state]] = at;
  return times;
}

/** Epoch milliseconds at which each state of a block was first observed. */
export type CommitTimes = Partial<Record<CommitTimeKey, number>>;

/**
 * A transition's state. Everything the wire carries plus the one off-chain
 * outcome: the block that held this height was replaced by a different one
 * (`blockId` changed), so its state is final in the other sense.
 */
export type BlockState = CommitState | 'reorged';

/**
 * What a reader is told about a block this service has no record for: an order
 * older than the tracking window (see `windowSize`) is the common case, not an
 * error. Only ever appears on a response, never in the map.
 */
export type ConsensusState = BlockState | 'unknown';

/**
 * The HTTP block tags and the commit state each one stands for. Monad's
 * `latest` is a block that has been proposed, `safe` a block that has been
 * voted on, `finalized` one that is final — measured on testnet 2026-09-13,
 * where the three were consecutive heights.
 */
export const POLL_TAGS = ['latest', 'safe', 'finalized'] as const;
export type PollTag = (typeof POLL_TAGS)[number];

export const POLL_TAG_STATES: Record<PollTag, CommitState> = {
  latest: 'Proposed',
  safe: 'Voted',
  finalized: 'Finalized',
};

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * What the service keeps per block. `at` records when each state was first
 * seen, so a ramp can space its marks by the real timings (and show a gap
 * where a block skipped `Voted`). Instances are replaced, never mutated —
 * `stateOf` hands out the stored record.
 */
/**
 * Which source an id came from. This matters because the two sources do NOT
 * report the same value for the same block: the socket reports Monad's
 * consensus `blockId`, the HTTP tags report the execution block hash. An id is
 * only ever a reorg witness against another id from its own source (SEN-35).
 */
export type BlockIdSource = 'socket' | 'http';

/** One observation's identity for a height: the id, and which source said so. */
export interface BlockIdentity {
  readonly id: string;
  readonly source: BlockIdSource;
}

export interface ConsensusRecord {
  /** The height. The map key, and the number an order's event carries. */
  readonly blockNumber: number;
  /**
   * Monad's consensus id for the block. Stable across every one of its commit
   * states, which is what makes it the reorg witness. Only the socket reports
   * it, so it is `undefined` for a height the HTTP fallback found on its own.
   */
  readonly blockId?: string;
  /**
   * The execution hash, as `eth_getBlockByNumber` reports it. A DIFFERENT value
   * from `blockId` for the same block — never compare the two.
   */
  readonly blockHash?: string;
  /** The furthest state observed. Never regresses, however the pushes arrive. */
  readonly state: CommitState;
  readonly at: Readonly<CommitTimes>;
}

/** One move, as yielded by `watch`. */
export interface ConsensusTransition {
  readonly blockNumber: number;
  /** The block this is about — the OLD one when `state` is `reorged`. */
  readonly blockId?: string;
  /** Its execution hash, when the fallback is what saw this block. */
  readonly blockHash?: string;
  readonly state: BlockState;
  /** The state it moved from; `undefined` when the block is first seen. */
  readonly previousState?: BlockState;
  /** The block's `at` map after this transition. */
  readonly at: Readonly<CommitTimes>;
  /** Epoch ms at which this transition was observed. */
  readonly observedAt: number;
  /** Ms since the block's first observation: 0 for a block's first transition. */
  readonly elapsedMs: number;
}

/** `stateOf` and `watch`, which is all a consumer needs — and all they get. */
export interface ConsensusSource {
  /** The block's record, or `undefined` if it is outside the tracking window. */
  stateOf(blockNumber: number): ConsensusRecord | undefined;
  /**
   * Follow one block: an async iterator of its transitions, starting with the
   * next one. Call `stateOf` first for where it already is. Iterating a block
   * the service never sees yields nothing; breaking out of the loop (or
   * `return()`) unsubscribes.
   */
  watch(blockNumber: number): AsyncIterableIterator<ConsensusTransition>;
}

// ---------------------------------------------------------------------------
// What the service needs from the outside
// ---------------------------------------------------------------------------

/** One block as the HTTP tags report it: a height and its execution hash. */
export interface TaggedBlock {
  readonly number: number;
  /**
   * The block hash. NOT Monad's `blockId`, which only the socket reports — it
   * is stored as `blockHash` and only ever compared against another hash.
   */
  readonly id: string;
}

/** `eth_getBlockByNumber` by tag. `undefined` when the node has no such block. */
export interface TaggedBlockReader {
  getBlockByTag(tag: PollTag): Promise<TaggedBlock | undefined>;
}

/**
 * The slice of a WebSocket this service uses. Node's global `WebSocket`,
 * `ws`, and the spec's fake all satisfy it.
 */
export interface ConsensusSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type ConnectSocket = (url: string) => ConsensusSocket;

/** Only `log` and `warn` are used; Nest's `Logger` satisfies both. */
export interface ConsensusLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ConsensusOptions {
  /** `wss://…`, the `monadNewHeads` subscription source. */
  wsUrl: string;
  /** The `eth_getBlockByNumber` fallback's reader. */
  readBlock: TaggedBlockReader;
  /** Defaults to Node's global `WebSocket`. */
  connect?: ConnectSocket;
  /** How many heights stay queryable. Default `CONSENSUS_WINDOW_BLOCKS`. */
  windowSize?: number;
  /** Fallback poll period while the socket is down. Default 300 ms. */
  pollIntervalMs?: number;
  /** Reconnect backoff. Default 500 ms doubling to 10 s. */
  reconnect?: { baseMs?: number; maxMs?: number };
  /** Transitions a `watch` iterator will hold for a slow consumer. Default 64. */
  watchQueueLimit?: number;
  /** The clock, for specs. Default `Date.now`. */
  now?: () => number;
  logger?: ConsensusLogger;
  /** Subscribe when Nest initialises the module. Default true. */
  autoStart?: boolean;
}

export const DEFAULT_MONAD_WS_URL = 'wss://testnet-rpc.monad.xyz';

/**
 * 512 heights. Monad testnet runs ~2 blocks/s, so this is roughly four minutes
 * of history — comfortably past the walk from a fill's receipt to the Ledger
 * reading it back, and nothing like a memory leak.
 */
export const CONSENSUS_WINDOW_BLOCKS = 512;

export const CONSENSUS_POLL_INTERVAL_MS = 300;
export const CONSENSUS_RECONNECT_BASE_MS = 500;
export const CONSENSUS_RECONNECT_MAX_MS = 10_000;
export const CONSENSUS_WATCH_QUEUE_LIMIT = 64;

/** Monad's own subscription name. Not a standard one — viem cannot speak it. */
export const MONAD_NEW_HEADS = 'monadNewHeads';

// ---------------------------------------------------------------------------
// Readers and sockets
// ---------------------------------------------------------------------------

/**
 * The viem-backed tag reader. `eth_getBlockByNumber` with `safe` and
 * `finalized` is what makes the HTTP fallback a real consensus signal rather
 * than a liveness ping.
 */
export function createTaggedBlockReader(rpcUrl: string): TaggedBlockReader {
  const client: PublicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl, { retryCount: 1 }),
  });
  return {
    getBlockByTag: async (tag) => {
      const block = await client.getBlock({ blockTag: tag });
      if (block.number === null || block.hash === null) return undefined;
      return { number: Number(block.number), id: block.hash };
    },
  };
}

/** Node 26's global `WebSocket`, which @types/node does not declare. */
type WebSocketConstructor = new (url: string) => ConsensusSocket;

/**
 * The default transport: the runtime's own `WebSocket` (undici's, in Node 26),
 * so this service adds no dependency. Only `data` is read off the message
 * event, which is why the constructor is narrowed to `ConsensusSocket`.
 */
export function connectWebSocket(url: string): ConsensusSocket {
  const constructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!constructor) {
    throw new Error('no global WebSocket in this runtime; pass `connect` to ConsensusService');
  }
  return new constructor(url);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** The id this record holds from `source`, or `undefined` if that source has not spoken. */
function idFrom(record: ConsensusRecord, source: BlockIdSource): string | undefined {
  return source === 'socket' ? record.blockId : record.blockHash;
}

/** One observation's id, under the field name its own source owns. */
function idFields(identity: BlockIdentity): Pick<ConsensusRecord, 'blockId' | 'blockHash'> {
  return identity.source === 'socket' ? { blockId: identity.id } : { blockHash: identity.id };
}

/** Epoch ms of the block's first observation, derived from `at`. */
export function firstObservedAt(record: ConsensusRecord): number {
  let first = Number.POSITIVE_INFINITY;
  for (const at of Object.values(record.at)) {
    if (typeof at === 'number' && at < first) first = at;
  }
  return Number.isFinite(first) ? first : 0;
}

export class ConsensusService implements ConsensusSource {
  private readonly options: ConsensusOptions;
  private readonly windowSize: number;
  private readonly pollIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly watchQueueLimit: number;
  private readonly now: () => number;
  private readonly logger: ConsensusLogger | undefined;
  private readonly connect: ConnectSocket;

  /** Bounded, oldest height evicted first. Insertion order is not height order. */
  private readonly blocks = new Map<number, ConsensusRecord>();
  private readonly watchers = new Map<number, Set<TransitionFeed>>();

  private socket: ConsensusSocket | undefined;
  private open = false;
  private stopped = false;
  private started = false;
  private attempt = 0;
  private nextRequestId = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  /** Subscription id the node acknowledged, so a stray push can be spotted. */
  private subscriptionId: string | undefined;

  constructor(options: ConsensusOptions) {
    this.options = options;
    this.windowSize = options.windowSize ?? CONSENSUS_WINDOW_BLOCKS;
    this.pollIntervalMs = options.pollIntervalMs ?? CONSENSUS_POLL_INTERVAL_MS;
    this.reconnectBaseMs = options.reconnect?.baseMs ?? CONSENSUS_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnect?.maxMs ?? CONSENSUS_RECONNECT_MAX_MS;
    this.watchQueueLimit = options.watchQueueLimit ?? CONSENSUS_WATCH_QUEUE_LIMIT;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.connect = options.connect ?? connectWebSocket;
  }

  /** Nest lifecycle. Both are no-ops unless the module wired the service in. */
  onModuleInit(): void {
    if (this.options.autoStart !== false) this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // -- reading --------------------------------------------------------------

  stateOf(blockNumber: number): ConsensusRecord | undefined {
    return this.blocks.get(blockNumber);
  }

  watch(blockNumber: number): AsyncIterableIterator<ConsensusTransition> {
    const feed = new TransitionFeed(this.watchQueueLimit, () => {
      const set = this.watchers.get(blockNumber);
      set?.delete(feed);
      if (set?.size === 0) this.watchers.delete(blockNumber);
    });
    const set = this.watchers.get(blockNumber) ?? new Set<TransitionFeed>();
    set.add(feed);
    this.watchers.set(blockNumber, set);
    return feed;
  }

  /** How many heights are tracked. Specs and the live script read this. */
  get size(): number {
    return this.blocks.size;
  }

  /** The tracking window, so a 404 can say how far back it goes. */
  get window(): number {
    return this.windowSize;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Idempotent. Connects and, on failure, keeps trying with backoff.
   *
   * The fallback poll starts here rather than on the first `close`: until the
   * socket has actually opened, `eth_subscribe` is unconfirmed, and a
   * handshake that hangs (never opens, never closes) would otherwise leave the
   * service with no source at all. `onopen` stops it.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.startPolling();
    this.connectSocket();
  }

  /** Stops for good: closes the socket, cancels both timers. Watchers end on their own. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopPolling();
    const socket = this.socket;
    this.socket = undefined;
    this.open = false;
    if (socket) closeQuietly(socket);
  }

  private connectSocket(): void {
    if (this.stopped || this.socket) return;
    let socket: ConsensusSocket;
    try {
      socket = this.connect(this.options.wsUrl);
    } catch (error) {
      this.logger?.warn(`consensus: could not open ${this.options.wsUrl}: ${describe(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempt = 0;
      this.stopPolling();
      this.subscribe(socket);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onMessage(event.data);
    };
    socket.onclose = () => this.ended(socket, 'closed');
    socket.onerror = (error) => this.ended(socket, `errored (${describe(error)})`);
  }

  /** The single exit from a socket's life, whether it closed or errored. */
  private ended(socket: ConsensusSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.open = false;
    this.subscriptionId = undefined;
    closeQuietly(socket);
    if (this.stopped) return;
    this.logger?.warn(`consensus: ${this.options.wsUrl} ${reason}; polling until it is back`);
    this.startPolling();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // No jitter: one client per API instance, so there is no herd to spread.
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connectSocket();
    }, delay);
  }

  private subscribe(socket: ConsensusSocket): void {
    this.nextRequestId += 1;
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextRequestId,
        method: 'eth_subscribe',
        params: [MONAD_NEW_HEADS],
      }),
    );
  }

  // -- the socket's notifications -------------------------------------------

  private onMessage(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.logger?.warn('consensus: dropped a non-JSON frame');
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const frame = message as Record<string, unknown>;

    if (frame['id'] !== undefined) {
      // The answer to our `eth_subscribe`.
      if (frame['error'] !== undefined) {
        this.logger?.warn(`consensus: ${MONAD_NEW_HEADS} refused: ${describe(frame['error'])}`);
        const socket = this.socket;
        if (socket) this.ended(socket, 'refused the subscription');
        return;
      }
      if (typeof frame['result'] === 'string') this.subscriptionId = frame['result'];
      return;
    }

    if (frame['method'] !== 'eth_subscription') return;
    const params = frame['params'];
    if (typeof params !== 'object' || params === null) return;
    const { subscription, result } = params as Record<string, unknown>;
    if (this.subscriptionId !== undefined && subscription !== this.subscriptionId) return;

    const head = parseHead(result);
    if (!head) {
      this.logger?.warn(`consensus: dropped an unrecognised ${MONAD_NEW_HEADS} head`);
      return;
    }
    this.apply(head.blockNumber, { id: head.blockId, source: 'socket' }, head.state, this.now());
  }

  // -- the map --------------------------------------------------------------

  /**
   * Fold one observation in, emitting whatever it changed. Everything the two
   * sources know arrives here, so a block that skips `Voted` needs no special
   * case: the states are simply the ones that were seen.
   *
   * SEN-35: a reorg is decided by comparing the incoming id against the id this
   * record already holds FROM THE SAME SOURCE. The socket's `blockId` and the
   * fallback's block hash are different values for the same block, so comparing
   * across the two reported a reorg on every socket flap — the ramp played
   * backwards and said "reordered, resubmitting" about a block that never
   * moved. A source whose id this record has not seen yet simply contributes
   * it; learning the socket's id for a height the fallback found is not a
   * reorg, and does not reset what the block has already been through.
   */
  private apply(
    blockNumber: number,
    identity: BlockIdentity,
    state: CommitState,
    when: number,
  ): void {
    const existing = this.blocks.get(blockNumber);
    const held = existing ? idFrom(existing, identity.source) : undefined;
    const reorged = held !== undefined && held !== identity.id;

    if (existing && reorged) {
      // A reorg: this height now holds a different block. Say so about the old
      // one before the new one takes its place in the map.
      this.emit({
        blockNumber,
        blockId: existing.blockId,
        blockHash: existing.blockHash,
        state: 'reorged',
        previousState: existing.state,
        at: existing.at,
        observedAt: when,
        elapsedMs: when - firstObservedAt(existing),
      });
    }

    if (!existing || reorged) {
      // A fresh block carries only the id that was actually observed: the other
      // source's id, if there was one, described the block that is now gone.
      const record: ConsensusRecord = {
        blockNumber,
        ...idFields(identity),
        state,
        at: commitTimes(state, when),
      };
      this.blocks.set(blockNumber, record);
      this.prune();
      this.emit({
        ...record,
        ...(existing ? { previousState: 'reorged' as const } : {}),
        observedAt: when,
        elapsedMs: 0,
      });
      return;
    }

    // Same block, possibly seen for the first time by this source.
    const known: ConsensusRecord =
      held === undefined ? { ...existing, ...idFields(identity) } : existing;

    // A repeat or an out-of-order push is not a transition — but the id it
    // carried is still worth keeping.
    if (STATE_RANK[state] <= STATE_RANK[existing.state]) {
      if (known !== existing) this.blocks.set(blockNumber, known);
      return;
    }

    const record: ConsensusRecord = {
      ...known,
      state,
      at: { ...existing.at, ...commitTimes(state, when) },
    };
    this.blocks.set(blockNumber, record);
    this.emit({
      ...record,
      previousState: existing.state,
      observedAt: when,
      elapsedMs: when - firstObservedAt(existing),
    });
  }

  private emit(transition: ConsensusTransition): void {
    const set = this.watchers.get(transition.blockNumber);
    if (!set) return;
    for (const feed of set) {
      try {
        feed.push(transition);
      } catch (error) {
        this.logger?.warn(`consensus: a watcher threw: ${describe(error)}`);
      }
    }
  }

  /** Drop the lowest heights until the window is respected. */
  private prune(): void {
    while (this.blocks.size > this.windowSize) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const height of this.blocks.keys()) {
        if (height < oldest) oldest = height;
      }
      this.blocks.delete(oldest);
    }
  }

  // -- the HTTP fallback ----------------------------------------------------

  /**
   * One pass over `latest`, `safe` and `finalized`. Public because it is
   * exactly what the timer runs, and because a spec can then assert the
   * fallback without racing a clock.
   */
  async pollOnce(): Promise<void> {
    const observedAt = this.now();
    const readings = await Promise.all(
      POLL_TAGS.map(async (tag) => {
        try {
          return { tag, block: await this.options.readBlock.getBlockByTag(tag) };
        } catch (error) {
          this.logger?.warn(`consensus: eth_getBlockByNumber(${tag}) failed: ${describe(error)}`);
          return { tag, block: undefined };
        }
      }),
    );
    for (const { tag, block } of readings) {
      if (!block) continue;
      this.apply(block.number, { id: block.id, source: 'http' }, POLL_TAG_STATES[tag], observedAt);
    }
  }

  /** Polls only while the socket is not open — the fallback, not a second source. */
  private startPolling(): void {
    if (this.stopped || this.pollTimer) return;
    const tick = (): void => {
      this.pollTimer = undefined;
      if (this.stopped || this.open) return;
      const next = async (): Promise<void> => {
        if (this.polling) return;
        this.polling = true;
        try {
          await this.pollOnce();
        } finally {
          this.polling = false;
        }
      };
      void next().finally(() => {
        if (!this.stopped && !this.open) {
          this.pollTimer = this.setTimer(tick, this.pollIntervalMs);
        }
      });
    };
    this.pollTimer = this.setTimer(tick, 0);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * A timer that does not hold the process open: the API's HTTP server and the
   * live script's own await are what keep things alive, not this.
   */
  private setTimer(run: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  }
}

// ---------------------------------------------------------------------------
// Transitions, to one consumer
// ---------------------------------------------------------------------------

/**
 * The iterator `watch` returns. Transitions are queued while a consumer is not
 * awaiting; past `limit` the OLDEST is dropped, so a consumer that stops
 * reading for a while sees the recent moves rather than a stale burst.
 */
export class TransitionFeed implements AsyncIterableIterator<ConsensusTransition> {
  private readonly queue: ConsensusTransition[] = [];
  /** Consumers parked in `next()`, oldest first: more than one may be waiting. */
  private readonly waiters: ((result: IteratorResult<ConsensusTransition>) => void)[] = [];
  private done = false;
  private readonly limit: number;
  private readonly onReturn: () => void;

  // Parameter properties are not erasable syntax, and this file is loaded by
  // node's type stripping in scripts/consensus-watch.ts (CLAUDE.md gotcha 10).
  constructor(limit: number, onReturn: () => void) {
    this.limit = limit;
    this.onReturn = onReturn;
  }

  push(transition: ConsensusTransition): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: transition, done: false });
      return;
    }
    this.queue.push(transition);
    if (this.queue.length > this.limit) this.queue.splice(0, this.queue.length - this.limit);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ConsensusTransition> {
    return this;
  }

  next(): Promise<IteratorResult<ConsensusTransition>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<ConsensusTransition>> {
    if (!this.done) {
      this.done = true;
      this.queue.length = 0;
      for (const waiter of this.waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
      this.onReturn();
    }
    return Promise.resolve({ value: undefined, done: true });
  }
}

// ---------------------------------------------------------------------------
// Parsing a head
// ---------------------------------------------------------------------------

interface ParsedHead {
  blockNumber: number;
  blockId: string;
  state: CommitState;
}

const BLOCK_ID = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]+$/;

/**
 * `monadNewHeads` carries a whole block header. The three fields that matter:
 * `number` (hex), `blockId` (the consensus id — the same value across all of a
 * block's states, which is what a reorg breaks) and `commitState`.
 */
function parseHead(value: unknown): ParsedHead | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const head = value as Record<string, unknown>;
  const { blockId, commitState, number } = head;
  if (typeof blockId !== 'string' || !BLOCK_ID.test(blockId)) return undefined;
  if (typeof commitState !== 'string' || !isCommitState(commitState)) return undefined;
  if (typeof number !== 'string' || !HEX.test(number)) return undefined;
  return { blockNumber: Number(BigInt(number)), blockId, state: commitState };
}

function isCommitState(value: string): value is CommitState {
  return (COMMIT_STATES as readonly string[]).includes(value);
}

function closeQuietly(socket: ConsensusSocket): void {
  try {
    socket.close();
  } catch {
    // A socket already gone is not an error worth reporting.
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
