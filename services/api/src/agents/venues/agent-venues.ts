/**
 * An agent's venues: `forAgent(agent) → { kuru, perpl? }`.
 *
 * - `kuru` always: a `KuruVenue` whose submitter signs through the agent's
 *   Privy wallet ({@link PrivyKuruSubmitter}).
 * - `perpl` only once the agent holds Perpl credentials (onboarded and
 *   enrolled through {@link PerplAgentAccounts}); absent otherwise.
 *
 * A Perpl venue holds a long-lived authenticated socket, so the set is cached
 * per agent and torn down after `idleMs` without a `forAgent` call, or at once
 * on `release(agentId)` (revocation). Callers should ask `forAgent` per task
 * rather than keep a set across idle periods.
 *
 * Erasable syntax and `.ts` specifiers only (scripts load this file).
 */
import { KuruVenue } from '@sente/venues/kuru';
import {
  PERPL_NETWORKS,
  PerplVenue,
  type PerplCredentials,
  type PerplNetwork,
} from '@sente/venues/perpl';
import type { PublicClient } from 'viem';

import type { AgentSecretStore } from './agent-secret-store.ts';
import type { AgentIdentity, AgentTransactionSender } from './agent-transactions.ts';
import { PrivyKuruSubmitter } from './privy-kuru-submitter.ts';

export interface AgentVenueSet {
  readonly kuru: KuruVenue;
  readonly perpl?: PerplVenue;
}

export interface AgentVenuesOptions {
  readonly publicClient: PublicClient;
  readonly sender: AgentTransactionSender;
  readonly secrets: AgentSecretStore;
  /** Defaults to testnet. */
  readonly perplNetwork?: PerplNetwork;
  /** Close an agent's Perpl socket after this long without use. Default 5 min. */
  readonly idleMs?: number;
  /** Seam for specs. */
  readonly createPerplVenue?: (credentials: PerplCredentials) => PerplVenue;
}

interface Entry {
  readonly walletId: string;
  readonly kuru: KuruVenue;
  perpl?: PerplVenue;
  timer?: ReturnType<typeof setTimeout>;
}

export const AGENT_VENUES_IDLE_MS = 5 * 60_000;

export class AgentVenues {
  readonly #publicClient: PublicClient;
  readonly #sender: AgentTransactionSender;
  readonly #secrets: AgentSecretStore;
  readonly #idleMs: number;
  readonly #createPerpl: (credentials: PerplCredentials) => PerplVenue;
  readonly #entries = new Map<string, Entry>();

  constructor(options: AgentVenuesOptions) {
    this.#publicClient = options.publicClient;
    this.#sender = options.sender;
    this.#secrets = options.secrets;
    this.#idleMs = options.idleMs ?? AGENT_VENUES_IDLE_MS;
    const network = options.perplNetwork ?? PERPL_NETWORKS.testnet;
    this.#createPerpl =
      options.createPerplVenue ?? ((credentials) => new PerplVenue({ credentials, network }));
  }

  async forAgent(agent: AgentIdentity): Promise<AgentVenueSet> {
    const credentials = await this.#secrets.getPerplCredentials(agent.agentId);

    // Synchronous from here: no await between reading and writing the cache.
    let entry = this.#entries.get(agent.agentId);
    if (entry && entry.walletId !== agent.walletId) {
      this.release(agent.agentId);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        walletId: agent.walletId,
        kuru: new KuruVenue({
          publicClient: this.#publicClient,
          submitter: new PrivyKuruSubmitter({ wallet: agent, sender: this.#sender }),
        }),
      };
      this.#entries.set(agent.agentId, entry);
    }
    if (!entry.perpl && credentials) entry.perpl = this.#createPerpl(credentials);

    this.#touch(agent.agentId, entry);
    return entry.perpl ? { kuru: entry.kuru, perpl: entry.perpl } : { kuru: entry.kuru };
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

  #touch(agentId: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.release(agentId), this.#idleMs);
    entry.timer.unref?.();
  }
}
