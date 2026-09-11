/**
 * Server-side secrets an agent holds at its venues. Today: its Perpl API key.
 *
 * The Perpl Ed25519 secret signs every Perpl order the agent sends, and it
 * never leaves the server — not to the app, not to a log. Values handed out by
 * a store are SEALED: the fields are readable but not enumerable, and JSON and
 * `util.inspect` print a placeholder, so an accidental `console.log(creds)` or
 * a serialised error context shows nothing.
 *
 * Erasable syntax and `.ts` specifiers only (scripts load this file).
 */
import type { PerplCredentials } from '@sente/venues/perpl';

/** DI token for the {@link AgentSecretStore}. */
export const AGENT_SECRETS = Symbol('AGENT_SECRETS');

export interface AgentSecretStore {
  getPerplCredentials(agentId: string): Promise<PerplCredentials | undefined>;
  putPerplCredentials(agentId: string, credentials: PerplCredentials): Promise<void>;
  /** Forget every secret held for this agent (revocation). */
  deleteAgent(agentId: string): Promise<void>;
}

const REDACTED = '[PerplCredentials redacted]';

/** A copy of `credentials` that reads normally and prints nothing. */
export function sealPerplCredentials(credentials: PerplCredentials): PerplCredentials {
  const sealed = {};
  Object.defineProperties(sealed, {
    apiKey: { value: credentials.apiKey, enumerable: false },
    secretKey: { value: Uint8Array.from(credentials.secretKey), enumerable: false },
    toJSON: { value: () => REDACTED, enumerable: false },
    [Symbol.for('nodejs.util.inspect.custom')]: { value: () => REDACTED, enumerable: false },
  });
  return sealed as PerplCredentials;
}

/**
 * PERSISTENCE: in memory, like the gas drip's ledger — this repo has no
 * database yet. A restart forgets every key, and the next use enrolls a new
 * one (an account holds at most 16 active keys). A durable store must encrypt
 * at rest; rebind AGENT_SECRETS and nothing else changes.
 */
export class InMemoryAgentSecretStore implements AgentSecretStore {
  readonly #perpl = new Map<string, PerplCredentials>();

  getPerplCredentials(agentId: string): Promise<PerplCredentials | undefined> {
    const held = this.#perpl.get(agentId);
    return Promise.resolve(held ? sealPerplCredentials(held) : undefined);
  }

  putPerplCredentials(agentId: string, credentials: PerplCredentials): Promise<void> {
    this.#perpl.set(agentId, sealPerplCredentials(credentials));
    return Promise.resolve();
  }

  deleteAgent(agentId: string): Promise<void> {
    this.#perpl.get(agentId)?.secretKey.fill(0);
    this.#perpl.delete(agentId);
    return Promise.resolve();
  }
}
