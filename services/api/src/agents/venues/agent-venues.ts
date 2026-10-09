/**
 * An agent's venues: `forAgent(agent) → { kuru, perpl? }`.
 *
 * - `kuru` always: a `KuruVenue` whose submitter signs through the agent's
 *   Privy wallet ({@link PrivyKuruSubmitter}).
 * - `perpl` only once the agent holds Perpl credentials (onboarded and
 *   enrolled through {@link PerplAgentAccounts}); absent otherwise.
 *
 * On-demand enrollment (SEN-148): no API path used to enroll an agent's Perpl
 * key, so every agent read as `not_enrolled`. Callers that know Perpl is in the
 * agent's mandate pass `enrollPerpl`, and the first such use with no stored
 * key enrolls one through `PerplAgentAccounts.credentials()` — single-flight
 * per agent, stored in the durable secret store, reused ever after (an
 * account holds at most 16 keys). A failure is remembered for
 * `enrollRetryMs` and reported as `perplUnavailable`, so a portfolio polled
 * every few seconds does not become an enrollment storm. Only exercised
 * against real Perpl and Privy once deployed; the specs run on fakes.
 *
 * A Perpl venue holds a long-lived authenticated socket, so the set is cached
 * per agent and torn down after `idleMs` without a `forAgent` call, or at once
 * on `release(agentId)` (revocation). Callers should ask `forAgent` per task
 * rather than keep a set across idle periods. Read-only callers that are not
 * the agent's run (the portfolio) use `readPerpl`, which never keeps one open.
 *
 * Erasable syntax and `.ts` specifiers only (scripts load this file).
 */
import { KuruVenue, type KuruBuilderSettings } from '@sente/venues/kuru';
import {
  PERPL_NETWORKS,
  PerplVenue,
  type PerplCredentials,
  type PerplNetwork,
} from '@sente/venues/perpl';
import { BaseError, type PublicClient } from 'viem';

import type { AgentSecretStore } from './agent-secret-store.ts';
import type { AgentIdentity, AgentTransactionSender } from './agent-transactions.ts';
import type { PerplAgentAccounts } from './perpl-agent.ts';
import { PrivyKuruSubmitter } from './privy-kuru-submitter.ts';

export interface AgentVenueSet {
  readonly kuru: KuruVenue;
  readonly perpl?: PerplVenue;
  /** Why `perpl` is absent when an on-demand enrollment was tried and failed. */
  readonly perplUnavailable?: string;
}

/** Whether a caller may enroll a Perpl key: only when Perpl is in the agent's mandate. */
export interface PerplAccessOptions {
  readonly enrollPerpl?: boolean;
  /**
   * The Sente builder fee this agent's Kuru orders pay (SEN-184), from
   * `agentKuruBuilder`. Absent: the plain overloads, which every agent policy
   * signs. A different value than the cached venue's rebuilds it.
   */
  readonly kuruBuilder?: KuruBuilderSettings;
}

export interface AgentVenuesOptions {
  readonly publicClient: PublicClient;
  readonly sender: AgentTransactionSender;
  readonly secrets: AgentSecretStore;
  /** Enrolls on demand. Without it, only already-stored keys are used. */
  readonly perplAccounts?: Pick<PerplAgentAccounts, 'credentials'>;
  /** How long a failed enrollment is not retried. Default 10 min. */
  readonly enrollRetryMs?: number;
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void };
  /** Defaults to testnet. */
  readonly perplNetwork?: PerplNetwork;
  /** Close an agent's Perpl socket after this long without use. Default 5 min. */
  readonly idleMs?: number;
  /** Seam for specs. */
  readonly createPerplVenue?: (credentials: PerplCredentials) => PerplVenue;
}

interface Entry {
  readonly walletId: string;
  /** `builderKey` of the fee `kuru` was built with. */
  builder: string;
  kuru: KuruVenue;
  perpl?: PerplVenue;
  timer?: ReturnType<typeof setTimeout>;
}

/** Stored credentials, or why there are none (`reason` only after a failed enrollment). */
interface PerplAccess {
  readonly credentials?: PerplCredentials;
  readonly reason?: string;
}

export const AGENT_VENUES_IDLE_MS = 5 * 60_000;
export const PERPL_ENROLL_RETRY_MS = 10 * 60_000;

export class AgentVenues {
  readonly #publicClient: PublicClient;
  readonly #sender: AgentTransactionSender;
  readonly #secrets: AgentSecretStore;
  readonly #accounts: Pick<PerplAgentAccounts, 'credentials'> | undefined;
  readonly #enrollRetryMs: number;
  readonly #now: () => number;
  readonly #logger: { warn(message: string): void } | undefined;
  readonly #idleMs: number;
  readonly #createPerpl: (credentials: PerplCredentials) => PerplVenue;
  readonly #entries = new Map<string, Entry>();
  readonly #enrollFailures = new Map<string, { readonly at: number; readonly reason: string }>();

  constructor(options: AgentVenuesOptions) {
    this.#publicClient = options.publicClient;
    this.#sender = options.sender;
    this.#secrets = options.secrets;
    this.#accounts = options.perplAccounts;
    this.#enrollRetryMs = options.enrollRetryMs ?? PERPL_ENROLL_RETRY_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#idleMs = options.idleMs ?? AGENT_VENUES_IDLE_MS;
    const network = options.perplNetwork ?? PERPL_NETWORKS.testnet;
    this.#createPerpl =
      options.createPerplVenue ?? ((credentials) => new PerplVenue({ credentials, network }));
  }

  async forAgent(agent: AgentIdentity, options: PerplAccessOptions = {}): Promise<AgentVenueSet> {
    const { credentials, reason } = await this.#perplAccess(agent, options);

    // Synchronous from here: no await between reading and writing the cache.
    let entry = this.#entries.get(agent.agentId);
    if (entry && entry.walletId !== agent.walletId) {
      this.release(agent.agentId);
      entry = undefined;
    }
    const builder = builderKey(options.kuruBuilder);
    if (!entry) {
      entry = { walletId: agent.walletId, builder, kuru: this.#kuru(agent, options.kuruBuilder) };
      this.#entries.set(agent.agentId, entry);
    } else if (entry.builder !== builder) {
      // An amend changed what the policy allows: the next order follows it.
      entry.kuru = this.#kuru(agent, options.kuruBuilder);
      entry.builder = builder;
    }
    if (!entry.perpl && credentials) entry.perpl = this.#createPerpl(credentials);

    this.#touch(agent.agentId, entry);
    if (entry.perpl) return { kuru: entry.kuru, perpl: entry.perpl };
    return reason === undefined
      ? { kuru: entry.kuru }
      : { kuru: entry.kuru, perplUnavailable: reason };
  }

  /**
   * Run `read` against the agent's Perpl venue without keeping one open for it
   * (SEN-122). A phone polling the portfolio every few seconds went through
   * `forAgent`, so each poll reset the idle timer and an agent that had long
   * stopped running held its authenticated socket for as long as the screen
   * stayed open. Here a socket the agent's own run already holds is borrowed
   * as is — its idle timer untouched — and otherwise a throwaway venue is
   * built for this one read and closed after it. `read` gets `undefined`
   * when the agent holds no Perpl credentials, and with it the reason when an
   * on-demand enrollment failed.
   */
  async readPerpl<T>(
    agent: AgentIdentity,
    read: (perpl: PerplVenue | undefined, unavailable?: string) => Promise<T>,
    options: PerplAccessOptions = {},
  ): Promise<T> {
    const live = this.#entries.get(agent.agentId)?.perpl;
    if (live && this.holdsPerpl(agent)) return read(live);

    const { credentials, reason } = await this.#perplAccess(agent, options);
    if (!credentials) return read(undefined, reason);
    const perpl = this.#createPerpl(credentials);
    try {
      return await read(perpl);
    } finally {
      perpl.close();
    }
  }

  /**
   * Whether the agent's run holds a Perpl socket `readPerpl` would borrow;
   * `false` means a read would open (and sign in on) a throwaway one.
   */
  holdsPerpl(agent: AgentIdentity): boolean {
    const live = this.#entries.get(agent.agentId);
    return live?.perpl !== undefined && live.walletId === agent.walletId;
  }

  /** Close the agent's Perpl socket and drop its venues — on revoke, or when idle. */
  release(agentId: string): void {
    const entry = this.#entries.get(agentId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.perpl?.close();
    this.#entries.delete(agentId);
  }

  /** Agents with a live venue set. */
  get size(): number {
    return this.#entries.size;
  }

  /** Nest lifecycle hook: close every socket on shutdown. */
  onModuleDestroy(): void {
    for (const agentId of [...this.#entries.keys()]) this.release(agentId);
  }

  async #perplAccess(agent: AgentIdentity, options: PerplAccessOptions): Promise<PerplAccess> {
    const held = await this.#secrets.getPerplCredentials(agent.agentId);
    if (held) return { credentials: held };
    if (!options.enrollPerpl || !this.#accounts) return {};

    const failed = this.#enrollFailures.get(agent.agentId);
    if (failed && this.#now() - failed.at < this.#enrollRetryMs) return { reason: failed.reason };
    try {
      // Single-flight lives in PerplAgentAccounts: concurrent first uses from
      // a run and a portfolio poll share one enrollment.
      const credentials = await this.#accounts.credentials(agent);
      this.#enrollFailures.delete(agent.agentId);
      return { credentials };
    } catch (error) {
      const reason = `Perpl enrollment failed: ${messageOf(error)}`;
      this.#enrollFailures.set(agent.agentId, { at: this.#now(), reason });
      this.#logger?.warn(
        `agent ${agent.agentId}: ${reason}; not retried for ${Math.round(this.#enrollRetryMs / 1000)} s`,
      );
      return { reason };
    }
  }

  #kuru(agent: AgentIdentity, builder: KuruBuilderSettings | undefined): KuruVenue {
    return new KuruVenue({
      publicClient: this.#publicClient,
      submitter: new PrivyKuruSubmitter({ wallet: agent, sender: this.#sender }),
      ...(builder ? { builder } : {}),
    });
  }

  #touch(agentId: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.release(agentId), this.#idleMs);
    entry.timer.unref?.();
  }
}

/**
 * The short message only: this reason reaches the phone and the logs, and
 * viem's full message carries the RPC URL, which can hold a provider key.
 * Nothing on the enrollment path puts the API secret in an error.
 */
function messageOf(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** What distinguishes one builder setting from another for the venue cache. */
function builderKey(builder: KuruBuilderSettings | undefined): string {
  if (!builder) return '';
  return `${builder.address.toLowerCase()}:${builder.feePps}:${builder.approvalExpiry(0)}`;
}
