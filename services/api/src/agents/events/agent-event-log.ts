/**
 * What an agent tried and what happened: every thesis, order, fill and
 * refusal its tools produce (SEN-7), plus the verdict on a thesis once a close
 * settles it (SEN-22). This is the data the Agent Ledger will show, so it is
 * written for completeness rather than for debugging — a
 * refusal names the layer that refused, and an order that failed at the venue
 * is recorded as well as one that landed.
 */

/** DI token for the agent event log. */
export const AGENT_EVENTS = Symbol('AGENT_EVENTS');

/**
 * `run`: one summary per Tool Runner run (SEN-8) — trigger, stop reason, iterations, cost.
 * `verdict`: a settled thesis (SEN-22) — its realised PnL and whether it held — appended
 * when a fill completes one (any filling tool, not just the Perpl-only `close_position`:
 * SEN-47), so the Ledger reads it through the events route like the rest.
 * `fill`: written by the gate for what an order filled at placement, and by
 * `fills/resting-fill.watcher.ts` for a resting Kuru order that fills later (SEN-149):
 * those carry `source: 'resting'`, a `tradeKey` they are deduplicated by, and no `runId`.
 * `deposit`: funds ARRIVING at the agent's wallet (SEN-30) — the only kind no tool
 * produces. It is appended by `POST /webhooks/alchemy` from an Alchemy Notify
 * Address Activity delivery, so it has no `runId` and no `tool`: nothing the agent
 * did caused it. Its `detail` is `webhooks/alchemy.ts#AgentDepositDetail`.
 */
export const AGENT_EVENT_KINDS = [
  'thesis',
  'order',
  'fill',
  'close',
  'verdict',
  'refusal',
  'run',
  'deposit',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/**
 * Who refused. `sente` is our own gate (layer 1: the thesis rule and
 * `checkIntent`); `enclave` is the Privy signing enclave (layer 2).
 */
export type RefusalLayer = 'sente' | 'enclave';

export interface AgentEvent {
  /** Increasing across the whole log, so events order and page stably. */
  readonly seq: number;
  readonly agentId: string;
  /** The Tool Runner run or MCP session that produced it. */
  readonly runId?: string;
  /** Unix epoch milliseconds. */
  readonly at: number;
  readonly kind: AgentEventKind;
  /** Set on every refusal, and only on refusals. */
  readonly layer?: RefusalLayer;
  /** The tool that produced it. */
  readonly tool?: string;
  /** JSON-safe: bigints are stored as decimal strings. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export type NewAgentEvent = Omit<AgentEvent, 'seq' | 'at'> & { readonly at?: number };

export interface AgentEventQuery {
  readonly runId?: string;
  readonly kind?: AgentEventKind;
  /** Only events after this `seq`. */
  readonly afterSeq?: number;
  /**
   * How many matches to return. With `afterSeq` that is the FIRST `limit` after
   * the cursor, so a client that has fallen more than a page behind catches up
   * page by page; without one it is the most recent `limit`, which is what a
   * screen opening on an agent's history wants (SEN-35).
   */
  readonly limit?: number;
}

/**
 * How much of an agent's history the log has dropped (SEN-129). The log keeps
 * the newest `maxPerAgent` events per agent, so past that `list` is no longer
 * the whole history — and every figure that sums or matches over the whole
 * history (FIFO cost basis, deposited capital, all-time P&L) would silently be
 * wrong. Readers of those figures ask this and say "unknown" instead.
 */
export interface AgentEventTruncation {
  /** Events dropped, oldest first. `0` means `list` is the agent's whole history. */
  readonly evicted: number;
  /**
   * The `at` of the newest dropped event, or `null` when none was dropped. A
   * figure over `[since, now]` is still whole when this is before `since`:
   * eviction is oldest-first, so nothing newer than it is gone.
   */
  readonly newestEvictedAt: number | null;
}

export const NOT_TRUNCATED: AgentEventTruncation = Object.freeze({
  evicted: 0,
  newestEvictedAt: null,
});

export interface AgentEventLog {
  /** Rejects a refusal without a `layer`, and a `layer` on anything else. */
  append(event: NewAgentEvent): Promise<AgentEvent>;
  /** The agent's events, oldest first. */
  list(agentId: string, query?: AgentEventQuery): Promise<AgentEvent[]>;
  /** What `list` no longer holds for this agent: see {@link AgentEventTruncation}. */
  truncation(agentId: string): Promise<AgentEventTruncation>;
}

/** Fold `more` dropped events into `base`. */
export function addTruncation(
  base: AgentEventTruncation,
  more: AgentEventTruncation,
): AgentEventTruncation {
  if (more.evicted === 0) return base;
  if (base.evicted === 0) return more;
  const newest = Math.max(base.newestEvictedAt ?? -Infinity, more.newestEvictedAt ?? -Infinity);
  return {
    evicted: base.evicted + more.evicted,
    // Both unknown stays unknown: `null` then reads as "maybe inside any window".
    newestEvictedAt: newest === -Infinity ? null : newest,
  };
}

/** A deep copy with bigints as decimal strings and `undefined` dropped: what JSON would keep. */
export function toJsonSafe<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

export const AGENT_EVENTS_PER_AGENT = 10_000;

/**
 * PERSISTENCE: in memory, like every other store in this API until it has a
 * database. Bounded per agent (oldest dropped first) so a chatty agent cannot
 * grow it without limit. What is dropped is counted per agent and answered by
 * `truncation` (SEN-129), so money read off the log can say it is partial.
 *
 * An event is copied ONCE, on the way in (`toJsonSafe` already deep-copies it),
 * and then deep-frozen, so reads hand out the stored record itself. They used
 * to `structuredClone` every match, which cost ~40 ms per unfiltered read at
 * the 10k cap — paid by the leaderboard and by every verdict (SEN-33). The
 * records are `readonly` to a TypeScript caller and frozen to everyone else.
 */
export class InMemoryAgentEventLog implements AgentEventLog {
  private readonly byAgent = new Map<string, AgentEvent[]>();
  private readonly truncated = new Map<string, AgentEventTruncation>();
  private seq = 0;

  /**
   * `seed` is a log read back from disk (SEN-65, `file-agent-event-log.ts`):
   * events that were already stamped and made JSON-safe before they were
   * written, so they are loaded as they are rather than re-appended. `seq`
   * carries on from the highest one, which keeps the phone's `afterSeq`
   * cursors valid across a restart. `seedTruncation` is what was dropped
   * before the seed was written (the file log's compaction), so a restart does
   * not forget that an agent's history is partial.
   */
  constructor(
    private readonly maxPerAgent = AGENT_EVENTS_PER_AGENT,
    seed: readonly AgentEvent[] = [],
    seedTruncation: ReadonlyMap<string, AgentEventTruncation> = new Map(),
  ) {
    for (const [agentId, truncation] of seedTruncation) {
      if (truncation.evicted > 0) this.truncated.set(agentId, truncation);
    }
    for (const event of [...seed].sort((a, b) => a.seq - b.seq)) {
      const events = this.byAgent.get(event.agentId) ?? [];
      events.push(deepFreeze(event));
      this.byAgent.set(event.agentId, events);
      this.seq = Math.max(this.seq, event.seq);
    }
    for (const events of this.byAgent.values()) this.evictOverflow(events);
  }

  append(event: NewAgentEvent): Promise<AgentEvent> {
    if ((event.kind === 'refusal') !== (event.layer !== undefined)) {
      return Promise.reject(new Error('a refusal must name its layer, and only a refusal has one'));
    }
    const stored: AgentEvent = deepFreeze({
      ...toJsonSafe(event),
      seq: ++this.seq,
      at: event.at ?? Date.now(),
    });
    const events = this.byAgent.get(event.agentId) ?? [];
    events.push(stored);
    this.evictOverflow(events);
    this.byAgent.set(event.agentId, events);
    return Promise.resolve(stored);
  }

  truncation(agentId: string): Promise<AgentEventTruncation> {
    return Promise.resolve(this.truncated.get(agentId) ?? NOT_TRUNCATED);
  }

  /** Drop one agent's oldest events past the cap, and remember that they were dropped. */
  private evictOverflow(events: AgentEvent[]): void {
    if (events.length <= this.maxPerAgent) return;
    const dropped = events.splice(0, events.length - this.maxPerAgent);
    const agentId = dropped[0]!.agentId;
    this.truncated.set(
      agentId,
      addTruncation(this.truncated.get(agentId) ?? NOT_TRUNCATED, {
        evicted: dropped.length,
        // A loop, not `Math.max(...)`: a boot can drop more events than a call takes arguments.
        newestEvictedAt: dropped.reduce((max, e) => Math.max(max, e.at), -Infinity),
      }),
    );
  }

  list(agentId: string, query: AgentEventQuery = {}): Promise<AgentEvent[]> {
    let events = (this.byAgent.get(agentId) ?? []).filter(
      (e) =>
        (query.runId === undefined || e.runId === query.runId) &&
        (query.kind === undefined || e.kind === query.kind) &&
        (query.afterSeq === undefined || e.seq > query.afterSeq),
    );
    if (query.limit !== undefined) {
      const limit = Math.max(0, query.limit);
      // `slice(-0)` is the whole array, so a limit of zero is its own case.
      if (limit === 0) {
        events = [];
      } else if (query.afterSeq === undefined) {
        // No cursor: the most recent page, which is where a screen opens.
        events = events.slice(-limit);
      } else {
        // Paging FORWARD takes the FIRST matches after the cursor. Taking the
        // last `limit` instead — as this did — silently skipped everything in
        // between for a client more than a page behind, and `nextSeq` then
        // moved past the gap, so those events were lost for good (SEN-35).
        events = events.slice(0, limit);
      }
    }
    return Promise.resolve(events);
  }
}

/**
 * Freeze an event and everything `detail` holds. `toJsonSafe` has already made
 * the value a private deep copy of plain JSON, so this only has to walk objects
 * and arrays — there is nothing else in it.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
