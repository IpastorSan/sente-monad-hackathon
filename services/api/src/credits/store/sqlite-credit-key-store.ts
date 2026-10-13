// The users' OpenRouter keys, in SQLite and still sealed (SEN-205).
//
// Same rules as `FileCreditKeyStore`: first-write-wins per user (the check and
// the insert are one transaction), each key sealed under `AGENT_SECRETS_KEY`
// with the user id bound in, and every row decrypted at boot so a wrong key
// fails the boot rather than starting empty and minting every user a second
// funded key. The row holds the file's record exactly, so the import copies
// ciphertext and never the key (`creditKeyRows`).
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`. Erasable
// syntax and `.ts` specifiers (gotcha 10).

import { RecordTable } from '../../state/db/record-table.ts';
import { toDataJson } from '../../state/db/row.ts';
import type { SenteDb } from '../../state/db/sente-db.ts';
import type { CreditKeyClaim, CreditKeyRecord, CreditKeyStore } from './credit-key-store.ts';
import { sealCreditKey, unsealCreditKey, type SealedCreditKey } from './file-credit-key-store.ts';

/** The `credit_keys` rows, sealed: what the import copies, with no key. */
export function creditKeyRows(db: SenteDb): RecordTable<SealedCreditKey> {
  return new RecordTable<SealedCreditKey>(
    db,
    'credit_keys',
    ['user_id', 'created_at', 'data'],
    (r) => [r.userId, r.createdAt.toISOString(), toDataJson(r)],
  );
}

export class SqliteCreditKeyStore implements CreditKeyStore {
  readonly #db: SenteDb;
  readonly #rows: RecordTable<SealedCreditKey>;
  readonly #secret: Buffer;

  /** Decrypts every row once, so a wrong key or a moved row fails the boot. */
  constructor(db: SenteDb, secret: Uint8Array) {
    if (secret.length !== 32) throw new Error('the credit keys secret must be 32 bytes');
    this.#db = db;
    this.#secret = Buffer.from(secret);
    this.#rows = creditKeyRows(db);
    for (const stored of this.#rows.all()) unsealCreditKey(this.#secret, stored, this.path);
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#rows.path;
  }

  /** How many keys the table holds. Logged at boot. */
  get size(): number {
    return this.#rows.size;
  }

  async find(userId: string): Promise<CreditKeyRecord | undefined> {
    const stored = this.#rows.get(userId);
    return stored ? unsealCreditKey(this.#secret, stored, this.path) : undefined;
  }

  async claim(record: Omit<CreditKeyRecord, 'createdAt'>): Promise<CreditKeyClaim> {
    return this.#db.transaction((): CreditKeyClaim => {
      const stored = this.#rows.get(record.userId);
      if (stored) return { ok: false, existing: unsealCreditKey(this.#secret, stored, this.path) };
      const created: CreditKeyRecord = { ...record, createdAt: new Date() };
      this.#rows.put(sealCreditKey(this.#secret, created));
      return { ok: true, record: created };
    });
  }
}
