import { randomUUID } from 'node:crypto';

import type { PerpsVenue, Venue } from '@sente/venues';
import type { KuruVenue } from '@sente/venues/kuru';

import type { AgentEventLog } from '../events/agent-event-log';
import type { AgentRecord, AgentStore } from '../store/agent-store';
import { KeyedMutex } from './keyed-mutex';

/** The Kuru surface the tools use: the shared `Venue` plus market lookup, deposits and withdrawals. */
export type KuruToolVenue = Venue &
  Pick<KuruVenue, 'market' | 'deposit' | 'withdraw' | 'walletBalances'>;

/** What `AgentVenues.forAgent` returns, narrowed to what the tools touch. */
export interface ToolVenues {
  readonly kuru: KuruToolVenue;
  /** Absent until the agent's wallet has enrolled a Perpl API key. */
  readonly perpl?: PerpsVenue;
}

export interface RecordedThesis {
  readonly market: string;
  readonly direction: 'long' | 'short';
  readonly thesis: string;
  readonly invalidation: string;
  /** Unix epoch ms. */
  readonly at: number;
}

/**
 * Everything a tool call needs, for ONE agent in ONE run. The Tool Runner
 * builds one per run (SEN-8); the MCP server builds one per session.
 */
export interface ToolContext {
  /** The agent as it was when the run started: its identity. */
  readonly agent: AgentRecord;
  /** Stamped on every event this run produces. */
  readonly runId: string;
  /** Resolved per call: `AgentVenues` closes idle sockets, so a run never holds a set. */
  readonly venues: () => Promise<ToolVenues>;
  readonly events: AgentEventLog;
  /** Market symbol → the thesis recorded for it in this run. */
  readonly theses: Map<string, RecordedThesis>;
  /** Layer 1 on or off (`AGENT_PRECHECK`). */
  readonly precheck: boolean;
  /** Per-agent, process-wide: shared by every run and session of the agent. */
  readonly writeLock: KeyedMutex;
  /**
   * The agent NOW. Writes re-read it, so an amended mandate applies at once
   * and a revoked agent stops mid-run.
   */
  readonly currentAgent: () => Promise<AgentRecord | undefined>;
  /** Unix seconds, for the mandate's expiry. */
  readonly now: () => number;
}

export interface AgentToolsOptions {
  readonly store: Pick<AgentStore, 'get'>;
  readonly venuesFor: (agent: AgentRecord) => Promise<ToolVenues>;
  readonly events: AgentEventLog;
  readonly precheck: boolean;
  readonly now?: () => number;
}

/**
 * Builds tool contexts. One instance per process (Nest singleton), because it
 * owns the per-agent write lock that every run and MCP session shares.
 */
export class AgentTools {
  readonly #options: AgentToolsOptions;
  readonly #writeLock = new KeyedMutex();

  constructor(options: AgentToolsOptions) {
    this.#options = options;
  }

  get precheck(): boolean {
    return this.#options.precheck;
  }

  context(agent: AgentRecord, options: { runId?: string } = {}): ToolContext {
    const { store, venuesFor, events, precheck } = this.#options;
    return {
      agent,
      runId: options.runId ?? `run-${randomUUID()}`,
      venues: () => venuesFor(agent),
      events,
      theses: new Map(),
      precheck,
      writeLock: this.#writeLock,
      currentAgent: () => store.get(agent.id),
      now: this.#options.now ?? (() => Math.floor(Date.now() / 1000)),
    };
  }
}
