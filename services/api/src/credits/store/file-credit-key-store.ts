// The users' OpenRouter keys, on disk and encrypted (SEN-204).
//
// Why durable: in memory every API restart forgot every binding while the keys
// lived on at OpenRouter, so the next provision minted each user a SECOND key
// with a fresh free-tier allowance. A restart was a free top-up, and nothing
// ever deleted the orphaned key.
//
// Why encrypted: the plaintext `sk-or-...` key is a bearer credential with
// money behind it. Sealed like the Perpl keys (`agents/venues/file-agent-secret-store.ts`):
// AES-256-GCM under `AGENT_SECRETS_KEY`, with the user id in the associated
// data so a record cannot be moved onto another user. The hash is not secret
// (it only addresses the key through the management API) and stays readable.
//
// A wrong key is FATAL at boot, never an empty store: an empty store here is
// exactly the free-top-up bug this file exists to close.

import {
  AGENT_SECRETS_KEY_VAR,
  sealBytes,
  unsealBytes,
  type Sealed,
} from '../../agents/venues/file-agent-secret-store';
import { JsonRecordFile } from '../../state/json-file';
import type { CreditKeyClaim, CreditKeyRecord, CreditKeyStore } from './credit-key-store';

/** The file name under `STATE_DIR`. */
export const CREDIT_KEYS_FILE = 'credit-keys';

/** Versioned so a later format change can tell old records apart. */
const keyAad = (userId: string): string => `sente/credit-keys/v1/openrouter/${userId}`;

/** What the file holds per user. */
interface StoredRecord {
  readonly userId: string;
  readonly hash: string;
  readonly key: Sealed;
  readonly createdAt: Date;
}

/** First-write-wins, like the in-memory store, and written through on every claim. */
export class FileCreditKeyStore implements CreditKeyStore {
  readonly #file: JsonRecordFile<StoredRecord>;
  readonly #secret: Buffer;
  readonly #stored = new Map<string, StoredRecord>();
  readonly #byUserId = new Map<string, CreditKeyRecord>();

  /** Loads and decrypts eagerly, so a wrong key or a bad file fails the boot. */
  constructor(path: string, secret: Uint8Array) {
    if (secret.length !== 32) throw new Error('the credit keys secret must be 32 bytes');
    this.#secret = Buffer.from(secret);
    this.#file = new JsonRecordFile<StoredRecord>(path);
    for (const stored of this.#file.load()) {
      this.#stored.set(stored.userId, stored);
      this.#byUserId.set(stored.userId, this.#unseal(stored));
    }
  }

  get path(): string {
    return this.#file.path;
  }

  get size(): number {
    return this.#byUserId.size;
  }

  find(userId: string): Promise<CreditKeyRecord | undefined> {
    return Promise.resolve(this.#byUserId.get(userId));
  }

  claim(record: Omit<CreditKeyRecord, 'createdAt'>): Promise<CreditKeyClaim> {
    const existing = this.#byUserId.get(record.userId);
    if (existing) return Promise.resolve({ ok: false, existing });
    const created: CreditKeyRecord = { ...record, createdAt: new Date() };
    const stored: StoredRecord = {
      userId: record.userId,
      hash: record.hash,
      key: sealBytes(this.#secret, keyAad(record.userId), Buffer.from(record.key, 'utf8')),
      createdAt: created.createdAt,
    };
    this.#stored.set(record.userId, stored);
    try {
      this.#file.save([...this.#stored.values()]);
    } catch (error) {
      // Unpersisted must not look persisted.
      this.#stored.delete(record.userId);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#byUserId.set(record.userId, created);
    return Promise.resolve({ ok: true, record: created });
  }

  #unseal(stored: StoredRecord): CreditKeyRecord {
    try {
      const plain = unsealBytes(this.#secret, keyAad(stored.userId), stored.key);
      const key = plain.toString('utf8');
      plain.fill(0);
      return { userId: stored.userId, hash: stored.hash, key, createdAt: stored.createdAt };
    } catch (error) {
      // No detail from `error`: GCM only ever says "unable to authenticate data".
      throw new Error(
        `${this.#file.path}: cannot decrypt user ${stored.userId}'s OpenRouter key with ` +
          `${AGENT_SECRETS_KEY_VAR}. Refusing to start: an empty store would mint every user ` +
          'a second funded key. Restore the key that wrote this file.',
        { cause: error },
      );
    }
  }
}
