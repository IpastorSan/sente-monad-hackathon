// The users' profile overrides, in SQLite (SEN-205).
//
// Same semantics as `FileProfileStore` — `applyProfilePatch` decides, so an
// unchanged patch writes nothing and a record back at both defaults is
// deleted — and `profile.store.spec.ts` runs both through one table.
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`. Erasable
// syntax and `.ts` specifiers so the import script can load it (gotcha 10).

import type { StatementSync } from 'node:sqlite';

import { fromRow, fromRows, toDataJson, upsertSql } from '../state/db/row.ts';
import type { SenteDb } from '../state/db/sente-db.ts';
import {
  applyProfilePatch,
  type ProfileRecord,
  type ProfileStore,
  type ProfileView,
} from './profile.store.ts';

const TABLE = 'profiles';
const COLUMNS = ['user_id', 'updated_at', 'data'] as const;

function row(record: ProfileRecord): string[] {
  return [record.userId, record.updatedAt.toISOString(), toDataJson(record)];
}

export class SqliteProfileStore implements ProfileStore {
  readonly #db: SenteDb;
  readonly #upsert: StatementSync;
  readonly #get: StatementSync;
  readonly #delete: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'user_id'));
    this.#get = db.prepare('SELECT data FROM profiles WHERE user_id = ?');
    this.#delete = db.prepare('DELETE FROM profiles WHERE user_id = ?');
    this.#all = db.prepare('SELECT data FROM profiles ORDER BY rowid');
    this.#count = db.prepare('SELECT count(*) AS n FROM profiles');
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many profiles the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  get(userId: string): ProfileView {
    const record = fromRow<ProfileRecord>(this.#get.get(userId));
    return { name: record?.name ?? null, avatarSeed: record?.avatarSeed ?? null };
  }

  set(userId: string, patch: Partial<ProfileView>, now: Date): ProfileView {
    return this.#db.transaction(() => {
      const previous = fromRow<ProfileRecord>(this.#get.get(userId));
      const { next, view, changed, empty } = applyProfilePatch(userId, previous, patch, now);
      if (!changed) return view;
      if (empty) this.#delete.run(userId);
      else this.#upsert.run(...row(next));
      return view;
    });
  }

  /** Insert or replace by user id. For `state/db/state-import.ts` only. */
  put(record: ProfileRecord): void {
    this.#upsert.run(...row(record));
  }

  /** Every record, in insertion order. For the import's verification. */
  async listAll(): Promise<ProfileRecord[]> {
    return fromRows(this.#all.all());
  }
}
