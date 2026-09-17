import {
  COMMIT_STATES,
  ConsensusService,
  type CommitState,
  type ConsensusSocket,
  type PollTag,
  type TaggedBlock,
  type TaggedBlockReader,
} from './consensus.service';

/**
 * What Monad testnet actually did on 2026-09-13 (docs/agents.md): Proposed, then
 * Voted ~216 ms later, Finalized at ~510 ms, Verified at about a second. The
 * specs below replay that shape through a fake socket, and these are the
 * offsets a ramp spaces its marks by.
 */
const OFF_VOTED_MS = 216;
const OFF_FINALIZED_MS = 510;
const OFF_VERIFIED_MS = 1_008;

const BLOCK = 63_310_247;
/** Monad's `blockId`: the same value across every state of a block. */
const ID_A = `0x${'a'.repeat(64)}`;
/** A different block at the same height — what a reorg looks like. */
const ID_B = `0x${'b'.repeat(64)}`;

/** The head `monadNewHeads` pushes: a whole block header, three fields of which matter. */
function head(blockNumber: number, blockId: string, commitState: string): Record<string, unknown> {
  return {
    blockId,
    commitState,
    number: `0x${blockNumber.toString(16)}`,
    hash: blockId,
    timestamp: '0x6aabd8e7',
  };
}

class FakeSocket implements ConsensusSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  /** Every frame the service sent, so `eth_subscribe` can be asserted. */
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** The node's answer to `eth_subscribe`, then the socket is live. */
  accept(subscription = '0xsub'): void {
    this.onopen?.();
    const id = JSON.parse(this.sent.at(-1) ?? '{}') as { id?: number };
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', id: id.id ?? 1, result: subscription }),
    });
  }

  /** One `eth_subscription` notification. */
  push(result: unknown, subscription = '0xsub'): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription, result },
      }),
    });
  }

  pushHead(blockNumber: number, blockId: string, commitState: string): void {
    this.push(head(blockNumber, blockId, commitState));
  }

  drop(): void {
    this.onclose?.();
  }

  fail(error: unknown = new Error('socket blew up')): void {
    this.onerror?.(error);
  }
}

class FakeTags implements TaggedBlockReader {
  /** The block each tag currently resolves to; absent means the node had none. */
  readonly byTag = new Map<PollTag, TaggedBlock>();
  readonly asked: PollTag[] = [];
  fail = false;

  getBlockByTag(tag: PollTag): Promise<TaggedBlock | undefined> {
    this.asked.push(tag);
    if (this.fail) return Promise.reject(new Error('rpc down'));
    return Promise.resolve(this.byTag.get(tag));
  }
}

const quiet = { log: () => undefined, warn: () => undefined };

interface Harness {
  service: ConsensusService;
  socket: FakeSocket;
  tags: FakeTags;
  /** Advance the injected clock; every observation is stamped with it. */
  advanced(ms: number): void;
}

function setup(
  overrides: Partial<ConstructorParameters<typeof ConsensusService>[0]> = {},
): Harness {
  let clock = 1_700_000_000_000;
  const socket = new FakeSocket();
  const tags = new FakeTags();
  const service = new ConsensusService({
    wsUrl: 'wss://example.invalid',
    readBlock: tags,
    connect: () => socket,
    now: () => clock,
    logger: quiet,
    autoStart: false,
    // Long enough that a spec's own awaits never race a real reconnect.
    reconnect: { baseMs: 10_000, maxMs: 10_000 },
    ...overrides,
  });
  return {
    service,
    socket,
    tags,
    advanced(ms) {
      clock += ms;
    },
  };
}

/** The next transition, or a failed spec rather than a hung one. */
async function nextOf(iterator: AsyncIterableIterator<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next().then((result) => result.value),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('no transition arrived')), 500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('ConsensusService', () => {
  it('subscribes to monadNewHeads and follows a block through all four states', async () => {
    const h = setup();
    h.service.start();
    h.socket.accept();

    expect(JSON.parse(h.socket.sent[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['monadNewHeads'],
    });

    const feed = h.service.watch(BLOCK);
    const moves = Promise.all([nextOf(feed), nextOf(feed), nextOf(feed), nextOf(feed)]);

    // Proposed +0 -> Voted +216 -> Finalized +510 -> Verified +1008.
    h.socket.pushHead(BLOCK, ID_A, 'Proposed');
    h.advanced(OFF_VOTED_MS);
    h.socket.pushHead(BLOCK, ID_A, 'Voted');
    h.advanced(OFF_FINALIZED_MS - OFF_VOTED_MS);
    h.socket.pushHead(BLOCK, ID_A, 'Finalized');
    h.advanced(OFF_VERIFIED_MS - OFF_FINALIZED_MS);
    h.socket.pushHead(BLOCK, ID_A, 'Verified');

    interface Move {
      state: string;
      previousState?: string;
      elapsedMs: number;
    }
    const transitions = (await moves) as Move[];
    expect(transitions.map((t) => [t.state, t.previousState, t.elapsedMs])).toEqual([
      ['Proposed', undefined, 0],
      ['Voted', 'Proposed', OFF_VOTED_MS],
      ['Finalized', 'Voted', OFF_FINALIZED_MS],
      ['Verified', 'Finalized', OFF_VERIFIED_MS],
    ]);

    const record = h.service.stateOf(BLOCK)!;
    const startedAt = record.at.proposed!;
    expect(record).toEqual({
      blockNumber: BLOCK,
      blockId: ID_A,
      state: 'Verified',
      at: {
        proposed: startedAt,
        voted: startedAt + OFF_VOTED_MS,
        finalized: startedAt + OFF_FINALIZED_MS,
        verified: startedAt + OFF_VERIFIED_MS,
      },
    });
    // Every state of one block carries Monad's one blockId.
    expect(record.state).toBe(COMMIT_STATES[3]);

    h.service.stop();
  });

  it('handles a block that skips Voted: Proposed then Finalized, with no voted stamp', () => {
    const h = setup();
    h.service.start();
    h.socket.accept();

    h.socket.pushHead(BLOCK, ID_A, 'Proposed');
    h.advanced(487);
    h.socket.pushHead(BLOCK, ID_A, 'Finalized');

    const record = h.service.stateOf(BLOCK)!;
    expect(record.state).toBe('Finalized');
    // The gap is the point: the ramp draws no Voted mark, because there was none.
    expect(Object.keys(record.at).sort()).toEqual(['finalized', 'proposed']);
    expect(record.at.finalized! - record.at.proposed!).toBe(487);

    h.service.stop();
  });

  it('treats a repeated or out-of-order push as no transition at all', async () => {
    const h = setup();
    h.service.start();
    h.socket.accept();

    const seen: string[] = [];
    const feed = h.service.watch(BLOCK);
    const pump = (async () => {
      for await (const transition of feed) {
        seen.push(transition.state);
        if (seen.length === 2) break;
      }
    })();

    h.socket.pushHead(BLOCK, ID_A, 'Proposed');
    h.socket.pushHead(BLOCK, ID_A, 'Voted');
    h.advanced(50);
    h.socket.pushHead(BLOCK, ID_A, 'Voted'); // the node repeats itself
    h.socket.pushHead(BLOCK, ID_A, 'Proposed'); // and can lag behind
    h.socket.pushHead(BLOCK, ID_A, 'Finalized');

    await pump;
    expect(seen).toEqual(['Proposed', 'Voted']);
    // The one that moved after the pump broke out is still folded in.
    expect(h.service.stateOf(BLOCK)!.state).toBe('Finalized');

    h.service.stop();
  });

  it('detects a reorg: the same height with a different blockId emits reorged for the old one', async () => {
    const h = setup();
    h.service.start();
    h.socket.accept();

    h.socket.pushHead(BLOCK, ID_A, 'Proposed');
    h.advanced(300);
    h.socket.pushHead(BLOCK, ID_A, 'Finalized');
    const settledAt = h.service.stateOf(BLOCK)!.at.finalized!;

    const feed = h.service.watch(BLOCK);
    const moves = Promise.all([nextOf(feed), nextOf(feed)]);

    // The height now holds a different block. The old one is gone.
    h.advanced(120);
    h.socket.pushHead(BLOCK, ID_B, 'Proposed');

    interface Move {
      blockId: string;
      state: string;
      previousState?: string;
      elapsedMs: number;
      at: Record<string, number>;
    }
    const [reorged, replacement] = (await moves) as [Move, Move];

    expect(reorged).toMatchObject({
      blockNumber: BLOCK,
      blockId: ID_A, // the TRANSITION names the block that was replaced
      state: 'reorged',
      previousState: 'Finalized',
      elapsedMs: 420,
    });
    // Its `at` is the record as it stood: a reorg is not a commit state.
    expect(reorged.at).toEqual({ proposed: settledAt - 300, finalized: settledAt });

    expect(replacement).toMatchObject({
      blockId: ID_B,
      state: 'Proposed',
      previousState: 'reorged',
      elapsedMs: 0,
    });

    // And the map now answers with the block that is actually there.
    const record = h.service.stateOf(BLOCK)!;
    expect(record.blockId).toBe(ID_B);
    expect(record.state).toBe('Proposed');
    expect(record.at.finalized).toBeUndefined();

    h.service.stop();
  });

  it('falls back to eth_getBlockByNumber(latest|safe|finalized) while the socket is down', async () => {
    const h = setup();
    // Three consecutive heights, as measured on testnet: latest is one ahead of
    // safe, which is one ahead of finalized.
    h.tags.byTag.set('latest', { number: BLOCK + 2, id: `0x${'1'.repeat(64)}` });
    h.tags.byTag.set('safe', { number: BLOCK + 1, id: `0x${'2'.repeat(64)}` });
    h.tags.byTag.set('finalized', { number: BLOCK, id: `0x${'3'.repeat(64)}` });

    await h.service.pollOnce();

    expect([...h.tags.asked].sort()).toEqual(['finalized', 'latest', 'safe']);
    expect(h.service.stateOf(BLOCK + 2)!.state).toBe('Proposed');
    expect(h.service.stateOf(BLOCK + 1)!.state).toBe('Voted');
    expect(h.service.stateOf(BLOCK)!.state).toBe('Finalized');
    // `Verified` is not observable over HTTP, and is never invented.
    for (const height of [BLOCK, BLOCK + 1, BLOCK + 2]) {
      expect(h.service.stateOf(height)!.at.verified).toBeUndefined();
    }

    h.service.stop();
  });

  it('polls on its own until the socket opens, then stops', async () => {
    const h = setup({ pollIntervalMs: 1 });
    h.tags.byTag.set('latest', { number: BLOCK, id: ID_A });
    h.tags.byTag.set('safe', { number: BLOCK - 1, id: `0x${'4'.repeat(64)}` });
    h.tags.byTag.set('finalized', { number: BLOCK - 2, id: `0x${'5'.repeat(64)}` });

    h.service.start();
    await waitFor(() => h.service.stateOf(BLOCK)?.state === 'Proposed');

    // The socket comes up: the fallback stops asking. It has not opened until
    // the node has acknowledged the subscription, which is why `accept` is two
    // frames and not one.
    h.socket.accept();
    const askedWhenOpen = h.tags.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.tags.asked.length).toBe(askedWhenOpen);

    // A dropped socket brings it straight back.
    h.socket.drop();
    await waitFor(() => h.tags.asked.length > askedWhenOpen);

    // ...and the socket is closed rather than left half-open.
    expect(h.socket.closed).toBe(true);

    h.service.stop();
  });

  it('keeps polling when a tag read fails, and recovers when it does not', async () => {
    const h = setup();
    h.tags.fail = true;
    await h.service.pollOnce();
    expect(h.service.size).toBe(0);

    h.tags.fail = false;
    h.tags.byTag.set('finalized', { number: BLOCK, id: ID_A });
    await h.service.pollOnce();
    expect(h.service.stateOf(BLOCK)!.state).toBe('Finalized');

    h.service.stop();
  });

  it('sees a reorg in the fallback too: the tag hash changes at the same height', async () => {
    const h = setup();
    h.tags.byTag.set('latest', { number: BLOCK, id: ID_A });
    await h.service.pollOnce();

    const feed = h.service.watch(BLOCK);
    const first = nextOf(feed);
    h.advanced(120);
    h.tags.byTag.set('latest', { number: BLOCK, id: ID_B });
    await h.service.pollOnce();

    expect(await first).toMatchObject({ state: 'reorged', blockId: ID_A, elapsedMs: 120 });
    expect(h.service.stateOf(BLOCK)!.blockId).toBe(ID_B);

    h.service.stop();
  });

  it('bounds the map to the tracking window, evicting the lowest height', () => {
    const h = setup({ windowSize: 3 });
    h.service.start();
    h.socket.accept();

    for (const height of [10, 11, 12, 13]) h.socket.pushHead(height, ID_A, 'Proposed');

    expect(h.service.size).toBe(3);
    expect(h.service.window).toBe(3);
    expect(h.service.stateOf(10)).toBeUndefined();
    expect([11, 12, 13].map((n) => h.service.stateOf(n)?.blockNumber)).toEqual([11, 12, 13]);

    h.service.stop();
  });

  it('ignores garbage: a malformed head, a foreign subscription, a non-JSON frame', () => {
    const h = setup();
    h.service.start();
    h.socket.accept('0xmine');

    h.socket.push({ blockId: 'not-a-hash', commitState: 'Proposed', number: '0x10' });
    h.socket.push(head(99, ID_A, 'Squashed')); // not one of the four states
    h.socket.push(head(99, ID_A, 'Proposed'), '0xsomeone-elses');
    h.socket.onmessage?.({ data: 'not json at all' });
    expect(h.service.size).toBe(0);

    // An error frame does not leave the socket half-up: it is dropped, and the
    // fallback takes over until the reconnect.
    h.socket.fail();
    expect(h.socket.closed).toBe(true);

    h.service.stop();
  });

  it('stops for good: no socket, no timers, and a watcher is released', async () => {
    const h = setup({ pollIntervalMs: 1 });
    h.tags.byTag.set('latest', { number: BLOCK, id: ID_A });
    h.service.start();
    await waitFor(() => h.service.size > 0);

    h.service.stop();
    const askedAtStop = h.tags.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.tags.asked.length).toBe(askedAtStop);

    // `stop` is how Nest tears the service down; a watcher simply stops being fed.
    const feed = h.service.watch(BLOCK);
    h.socket.pushHead(BLOCK, ID_A, 'Voted');
    const pending = feed.next();
    await feed.return?.();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    // And the push that arrived after stop was dropped, not queued.
    await expect(feed.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('queues transitions for a watcher that is not awaiting, dropping the oldest', async () => {
    const h = setup({ watchQueueLimit: 2 });
    h.service.start();
    h.socket.accept();

    const feed = h.service.watch(BLOCK);
    for (const state of COMMIT_STATES) h.socket.pushHead(BLOCK, ID_A, state);

    // Proposed was pushed out by the limit; Voted onward is what a slow
    // consumer sees, which is the recent shape rather than a stale burst.
    const moves: CommitState[] = [];
    for (const _ of [0, 1]) {
      const move = (await feed.next()).value as { state: CommitState };
      moves.push(move.state);
    }
    expect(moves).toEqual(['Finalized', 'Verified']);

    h.service.stop();
  });
});
