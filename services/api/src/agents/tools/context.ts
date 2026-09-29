import { randomUUID } from 'node:crypto';

import type { PerpsVenue, Venue } from '@sente/venues';
import type { KuruVenue } from '@sente/venues/kuru';

import type { MarketDataService } from '../../venues/market-data.service';
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

/**
 * The shared, cached market-data reads (SEN-79): one Perpl socket and one TTL
 * cache for every agent and phone, instead of a socket per run per market.
 * `mark` values a sell whose book is empty (SEN-133); `ticker` carries a
 * perp's funding (SEN-145).
 */
export type ToolMarketData = Pick<
  MarketDataService,
  'klines' | 'quote' | 'depth' | 'mark' | 'ticker'
>;

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
  /** Absent in specs that only fake the venues; reads then go to the agent's own venues. */
  readonly marketData?: ToolMarketData;
}

export interface AgentToolsOptions {
  readonly store: Pick<AgentStore, 'get'>;
  readonly venuesFor: (agent: AgentRecord) => Promise<ToolVenues>;
  readonly events: AgentEventLog;
  readonly precheck: boolean;
  readonly now?: () => number;
  readonly marketData?: ToolMarketData;
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

  /**
   * The per-agent write lock, for writers of the log outside a tool call: the
   * resting-fill watcher (SEN-149) appends fills and verdicts under it, so its
   * "is this verdict already on the log?" check cannot race the gate's.
   */
  get writeLock(): KeyedMutex {
    return this.#writeLock;
  }

  context(agent: AgentRecord, options: { runId?: string } = {}): ToolContext {
    const { store, venuesFor, events, precheck, marketData } = this.#options;
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
      ...(marketData ? { marketData } : {}),
    };
  }
}
