/**
 * What the server holds at a venue on a USER's behalf (SEN-100, plan M-T18,
 * D1/D3). Today, at Perpl:
 *
 * - a READ-scoped key per user — token and Ed25519 secret — which lets
 *   Portfolio sign in and read the account. It cannot place an order, and no
 *   Perpl key can withdraw. Its secret never leaves the server;
 * - the api-key TOKEN of the phone's trade key. Not a secret on its own (it
 *   signs nothing without the phone-held Ed25519 secret, D1); kept so
 *   `/trade/perpl/account` can hand it back to a reinstalled app.
 *
 * The server NEVER holds a key that can trade: there is no method here that
 * takes a trade-scoped secret.
 *
 * Handed-out read credentials are SEALED, exactly like an agent's
 * (`agents/venues/agent-secret-store.ts`): readable, but JSON and
 * `util.inspect` print a placeholder.
 *
 * PERSISTENCE: in memory, by decision (D3). A restart forgets every read key,
 * and Portfolio reports `perpl.status: 'unlinked'` until the phone approves a
 * new enrollment. Nothing is lost that the phone cannot re-authorize.
 *
 * Erasable syntax only (gotcha 10).
 */
import type { PerplCredentials } from '@sente/venues/perpl';

import { sealPerplCredentials } from '../agents/venues/agent-secret-store.ts';

/** DI token for the {@link UserVenueSecretStore}. */
export const USER_VENUE_SECRETS = Symbol('USER_VENUE_SECRETS');

export interface UserVenueSecretStore {
  /** The user's read-scoped Perpl credentials, sealed; undefined when unlinked. */
  getPerplRead(userId: string): Promise<PerplCredentials | undefined>;
  /** Replaces (and zeroes) any read key held for the user. Stores its own copy. */
  putPerplRead(userId: string, credentials: PerplCredentials): Promise<void>;
  getPerplTradeToken(userId: string): Promise<string | undefined>;
  putPerplTradeToken(userId: string, token: string): Promise<void>;
}

export class InMemoryUserVenueSecretStore implements UserVenueSecretStore {
  readonly #read = new Map<string, PerplCredentials>();
  readonly #tradeTokens = new Map<string, string>();

  getPerplRead(userId: string): Promise<PerplCredentials | undefined> {
    const held = this.#read.get(userId);
    return Promise.resolve(held ? sealPerplCredentials(held) : undefined);
  }

  putPerplRead(userId: string, credentials: PerplCredentials): Promise<void> {
    // A re-enrollment supersedes the old key; its secret is of no further use.
    this.#read.get(userId)?.secretKey.fill(0);
    this.#read.set(userId, sealPerplCredentials(credentials));
    return Promise.resolve();
  }

  getPerplTradeToken(userId: string): Promise<string | undefined> {
    return Promise.resolve(this.#tradeTokens.get(userId));
  }

  putPerplTradeToken(userId: string, token: string): Promise<void> {
    this.#tradeTokens.set(userId, token);
    return Promise.resolve();
  }
}
