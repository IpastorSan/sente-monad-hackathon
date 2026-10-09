// The users' venue secrets, on disk and encrypted (SEN-174).
//
// Why durable: in memory (D3, SEN-100) every restart forgot each user's
// read-scoped Perpl key and the trade key's api token, so Portfolio reported
// `perpl.status: 'unlinked'` and a reinstalled app could not get its token
// back until the phone approved a new enrollment, which uses up one of the
// account's 16 key slots.
//
// Why encrypted: the read key's Ed25519 secret signs Perpl reads as the user.
// Sealed exactly like the agents' keys (`agents/venues/file-agent-secret-store.ts`,
// whose helpers this reuses): AES-256-GCM under `AGENT_SECRETS_KEY`, with the
// user id and the field in the associated data so a record cannot be moved
// onto another user. The trade token is sealed too: it signs nothing on its
// own, but nothing gains from leaving it readable.
//
// A wrong key is FATAL at boot, never an empty store: same rule as the
// agents' file and `state/json-file.ts`.
//
// Erasable syntax and `.ts` specifiers only (gotcha 10).

import type { PerplCredentials } from '@sente/venues/perpl';

import { sealPerplCredentials } from '../agents/venues/agent-secret-store.ts';
import {
  AGENT_SECRETS_KEY_VAR,
  decodePerplCredentials,
  encodePerplCredentials,
  sealBytes,
  unsealBytes,
  type Sealed,
} from '../agents/venues/file-agent-secret-store.ts';
import { JsonRecordFile } from '../state/json-file.ts';
import type { UserVenueSecretStore } from './user-venue-secrets.ts';

/** The file name under `STATE_DIR`. */
export const USER_VENUE_SECRETS_FILE = 'user-venue-secrets';

/** Versioned so a later format change can tell old records apart. */
const AAD_PREFIX = 'sente/user-venue-secrets/v1/';
const readAad = (userId: string): string => `${AAD_PREFIX}perpl-read/${userId}`;
const tokenAad = (userId: string): string => `${AAD_PREFIX}perpl-trade-token/${userId}`;

/** What the file holds per user. Nothing in it is readable without the key. */
interface SecretRecord {
  readonly userId: string;
  readonly perplRead?: Sealed;
  readonly perplTradeToken?: Sealed;
}

/** One user's secrets, decrypted; the read key kept sealed like the in-memory store's. */
interface Held {
  readonly perplRead?: PerplCredentials;
  readonly perplTradeToken?: string;
}

export class FileUserVenueSecretStore implements UserVenueSecretStore {
  readonly #file: JsonRecordFile<SecretRecord>;
  readonly #key: Buffer;
  readonly #records = new Map<string, SecretRecord>();
  readonly #held = new Map<string, Held>();

  /** Loads and decrypts eagerly, so a wrong key or a bad file fails the boot. */
  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error('the venue secrets key must be 32 bytes');
    this.#key = Buffer.from(key);
    this.#file = new JsonRecordFile<SecretRecord>(path);
    for (const record of this.#file.load()) {
      this.#records.set(record.userId, record);
      this.#held.set(record.userId, this.#unseal(record));
    }
  }

  /** The file behind this store. Logged at boot. */
  get path(): string {
    return this.#file.path;
  }

  /** How many users' secrets came back from disk. Logged at boot. */
  get size(): number {
    return this.#records.size;
  }

  getPerplRead(userId: string): Promise<PerplCredentials | undefined> {
    const held = this.#held.get(userId)?.perplRead;
    return Promise.resolve(held ? sealPerplCredentials(held) : undefined);
  }

  putPerplRead(userId: string, credentials: PerplCredentials): Promise<void> {
    const previous = this.#held.get(userId)?.perplRead;
    const sealed = sealBytes(this.#key, readAad(userId), encodePerplCredentials(credentials));
    const failure = this.#update(
      userId,
      { perplRead: sealed },
      { perplRead: sealPerplCredentials(credentials) },
    );
    if (failure) return Promise.reject(failure);
    // A re-enrollment supersedes the old key; its secret is of no further use.
    previous?.secretKey.fill(0);
    return Promise.resolve();
  }

  getPerplTradeToken(userId: string): Promise<string | undefined> {
    return Promise.resolve(this.#held.get(userId)?.perplTradeToken);
  }

  putPerplTradeToken(userId: string, token: string): Promise<void> {
    const sealed = sealBytes(this.#key, tokenAad(userId), Buffer.from(token, 'utf8'));
    const failure = this.#update(userId, { perplTradeToken: sealed }, { perplTradeToken: token });
    return failure ? Promise.reject(failure) : Promise.resolve();
  }

  #unseal(record: SecretRecord): Held {
    try {
      let perplTradeToken: string | undefined;
      if (record.perplTradeToken) {
        const plain = unsealBytes(this.#key, tokenAad(record.userId), record.perplTradeToken);
        perplTradeToken = plain.toString('utf8');
        plain.fill(0);
      }
      const perplRead = record.perplRead
        ? decodePerplCredentials(unsealBytes(this.#key, readAad(record.userId), record.perplRead))
        : undefined;
      return { perplRead, perplTradeToken };
    } catch (error) {
      // No detail from `error`: GCM only ever says "unable to authenticate data".
      throw new Error(
        `${this.#file.path}: cannot decrypt user ${record.userId}'s Perpl keys with ` +
          `${AGENT_SECRETS_KEY_VAR}. Refusing to start: a wrong key would unlink every user, ` +
          'and each re-enrollment uses a Perpl key slot. Restore the key that wrote this file.',
        { cause: error },
      );
    }
  }

  /**
   * Writes through. On a failed write memory is put back, so it never runs
   * ahead of disk, and the error is returned for the caller to reject with.
   */
  #update(userId: string, record: Omit<SecretRecord, 'userId'>, held: Held): Error | undefined {
    const previousRecord = this.#records.get(userId);
    const previousHeld = this.#held.get(userId);
    this.#records.set(userId, { ...previousRecord, ...record, userId });
    this.#held.set(userId, { ...previousHeld, ...held });
    try {
      this.#file.save([...this.#records.values()]);
      return undefined;
    } catch (error) {
      if (previousRecord && previousHeld) {
        this.#records.set(userId, previousRecord);
        this.#held.set(userId, previousHeld);
      } else {
        this.#records.delete(userId);
        this.#held.delete(userId);
      }
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
