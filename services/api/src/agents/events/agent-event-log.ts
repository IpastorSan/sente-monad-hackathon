/**
 * What an agent tried and what happened: every thesis, order, fill and
 * refusal its tools produce (SEN-7). This is the data the Agent Ledger will
 * show, so it is written for completeness rather than for debugging — a
 * refusal names the layer that refused, and an order that failed at the venue
 * is recorded as well as one that landed.
 */

/** DI token for the agent event log. */
export const AGENT_EVENTS = Symbol('AGENT_EVENTS');

export const AGENT_EVENT_KINDS = ['thesis', 'order', 'fill', 'refusal'] as const;
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
  /** The most recent N matches. */
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
 * grow it without limit. Events are copied in and out.
 */
export class InMemoryAgentEventLog implements AgentEventLog {
  private readonly byAgent = new Map<string, AgentEvent[]>();
  private seq = 0;

  constructor(private readonly maxPerAgent = AGENT_EVENTS_PER_AGENT) {}

  append(event: NewAgentEvent): Promise<AgentEvent> {
    if ((event.kind === 'refusal') !== (event.layer !== undefined)) {
      return Promise.reject(new Error('a refusal must name its layer, and only a refusal has one'));
    }
    const stored: AgentEvent = {
      ...toJsonSafe(event),
      seq: ++this.seq,
      at: event.at ?? Date.now(),
    };
    const events = this.byAgent.get(event.agentId) ?? [];
    events.push(stored);
    if (events.length > this.maxPerAgent) events.splice(0, events.length - this.maxPerAgent);
    this.byAgent.set(event.agentId, events);
    return Promise.resolve(structuredClone(stored));
  }

  list(agentId: string, query: AgentEventQuery = {}): Promise<AgentEvent[]> {
    let events = (this.byAgent.get(agentId) ?? []).filter(
      (e) =>
        (query.runId === undefined || e.runId === query.runId) &&
        (query.kind === undefined || e.kind === query.kind) &&
        (query.afterSeq === undefined || e.seq > query.afterSeq),
    );
    if (query.limit !== undefined) events = events.slice(-Math.max(0, query.limit));
    return Promise.resolve(events.map((e) => structuredClone(e)));
  }
}
