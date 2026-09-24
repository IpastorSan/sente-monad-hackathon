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

export interface AgentEventLog {
  /** Rejects a refusal without a `layer`, and a `layer` on anything else. */
  append(event: NewAgentEvent): Promise<AgentEvent>;
  /** The agent's events, oldest first. */
  list(agentId: string, query?: AgentEventQuery): Promise<AgentEvent[]>;
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
 * grow it without limit.
 *
 * An event is copied ONCE, on the way in (`toJsonSafe` already deep-copies it),
 * and then deep-frozen, so reads hand out the stored record itself. They used
 * to `structuredClone` every match, which cost ~40 ms per unfiltered read at
 * the 10k cap — paid by the leaderboard and by every verdict (SEN-33). The
 * records are `readonly` to a TypeScript caller and frozen to everyone else.
 */
export class InMemoryAgentEventLog implements AgentEventLog {
  private readonly byAgent = new Map<string, AgentEvent[]>();
  private seq = 0;

  constructor(private readonly maxPerAgent = AGENT_EVENTS_PER_AGENT) {}

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
    if (events.length > this.maxPerAgent) events.splice(0, events.length - this.maxPerAgent);
    this.byAgent.set(event.agentId, events);
    return Promise.resolve(stored);
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
