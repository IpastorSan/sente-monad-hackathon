// The users' venue secrets, in SQLite and still sealed (SEN-205).
//
// Same rules as `FileUserVenueSecretStore`: the read key and the trade token
// each sealed under `AGENT_SECRETS_KEY` with the user id and the field bound
// in, every row decrypted at boot so a wrong key fails the boot instead of
// unlinking every user, and read credentials handed out sealed. The row holds
// the file's record exactly, so the import copies ciphertext and never the key
// (`userVenueSecretRows`). Nothing decrypted is kept in memory.
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`. Erasable
// syntax and `.ts` specifiers (gotcha 10).

import type { PerplCredentials } from '@sente/venues/perpl';

import { RecordTable } from '../state/db/record-table.ts';
import { toDataJson } from '../state/db/row.ts';
import type { SenteDb } from '../state/db/sente-db.ts';
import {
  sealPerplRead,
  sealPerplTradeToken,
  unsealUserVenueSecrets,
  type UserVenueSecretRecord,
} from './file-user-venue-secrets.ts';
import type { UserVenueSecretStore } from './user-venue-secrets.ts';

/** The `user_venue_secrets` rows, sealed: what the import copies, with no key. */
export function userVenueSecretRows(db: SenteDb): RecordTable<UserVenueSecretRecord> {
  return new RecordTable<UserVenueSecretRecord>(
    db,
    'user_venue_secrets',
    ['user_id', 'data'],
    (r) => [r.userId, toDataJson(r)],
  );
}

export class SqliteUserVenueSecretStore implements UserVenueSecretStore {
  readonly #db: SenteDb;
  readonly #rows: RecordTable<UserVenueSecretRecord>;
  readonly #key: Buffer;

  /** Decrypts every row once, so a wrong key or a moved row fails the boot. */
  constructor(db: SenteDb, key: Uint8Array) {
    if (key.length !== 32) throw new Error('the venue secrets key must be 32 bytes');
    this.#db = db;
    this.#key = Buffer.from(key);
    this.#rows = userVenueSecretRows(db);
    for (const record of this.#rows.all()) {
      unsealUserVenueSecrets(this.#key, record, this.path).perplRead?.secretKey.fill(0);
    }
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#rows.path;
  }

  /** How many users' secrets the table holds. Logged at boot. */
  get size(): number {
    return this.#rows.size;
  }

  async getPerplRead(userId: string): Promise<PerplCredentials | undefined> {
    return this.#held(userId)?.perplRead;
  }

  async putPerplRead(userId: string, credentials: PerplCredentials): Promise<void> {
    this.#merge(userId, { perplRead: sealPerplRead(this.#key, userId, credentials) });
  }

  async getPerplTradeToken(userId: string): Promise<string | undefined> {
    const held = this.#held(userId);
    held?.perplRead?.secretKey.fill(0);
    return held?.perplTradeToken;
  }

  async putPerplTradeToken(userId: string, token: string): Promise<void> {
    this.#merge(userId, { perplTradeToken: sealPerplTradeToken(this.#key, userId, token) });
  }

  #held(userId: string) {
    const record = this.#rows.get(userId);
    return record ? unsealUserVenueSecrets(this.#key, record, this.path) : undefined;
  }

  /** One field replaced, the other kept: read and write in one transaction. */
  #merge(userId: string, fields: Omit<UserVenueSecretRecord, 'userId'>): void {
    this.#db.transaction(() => {
      this.#rows.put({ ...this.#rows.get(userId), ...fields, userId });
    });
  }
}
