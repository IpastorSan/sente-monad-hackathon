// Who got a starter kit, in SQLite (SEN-205).
//
// Same semantics as `FileStarterKitStore`: one record per user ever, both
// daily caps counted from the table (failed kits included), a `pending` record
// found at boot turned `failed` and never retried. `claim` is one synchronous
// transaction, so the check and the write cannot interleave with another
// register's. The specs run both through one table.
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`; `created_at`
// and `ip_hash` serve the cap counts. Erasable syntax and `.ts` specifiers so
// the import script can load it (gotcha 10).

import type { StatementSync } from 'node:sqlite';

import type { Address } from 'viem';

import { utcDay } from '../gas/ledger/drip-ledger.ts';
import { fromRow, fromRows, insertSql, toDataJson, updateSql, upsertSql } from '../state/db/row.ts';
import type { SenteDb } from '../state/db/sente-db.ts';
import {
  hashIp,
  interrupted,
  pendingKit,
  type StarterKitClaim,
  type StarterKitIpLimit,
  type StarterKitRecord,
  type StarterKitStore,
} from './starter-kit.store.ts';

const TABLE = 'starter_kits';
const COLUMNS = [
  'user_id',
  'address',
  'status',
  'ip_hash',
  'created_at',
  'updated_at',
  'data',
] as const;

function row(record: StarterKitRecord): (string | null)[] {
  return [
    record.userId,
    record.address,
    record.status,
    record.ipHash ?? null,
    record.createdAt.toISOString(),
    record.updatedAt.toISOString(),
    toDataJson(record),
  ];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class SqliteStarterKitStore implements StarterKitStore {
  readonly #db: SenteDb;
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #update: StatementSync;
  readonly #find: StatementSync;
  readonly #countDay: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#insert = db.prepare(insertSql(TABLE, COLUMNS));
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'user_id'));
    this.#update = db.prepare(updateSql(TABLE, COLUMNS, 'user_id'));
    this.#find = db.prepare('SELECT data FROM starter_kits WHERE user_id = ?');
    // `ip_hash = NULL` is NULL, which `sum` skips: no IP given counts no IP matches.
    this.#countDay = db.prepare(
      'SELECT count(*) AS today, coalesce(sum(ip_hash = ?), 0) AS from_ip FROM starter_kits ' +
        'WHERE created_at >= ? AND created_at < ?',
    );
    this.#all = db.prepare('SELECT data FROM starter_kits ORDER BY rowid');
    this.#count = db.prepare('SELECT count(*) AS n FROM starter_kits');

    // Boot: whatever was mid-send when the process stopped is failed, never retried.
    const pending = db.prepare("SELECT data FROM starter_kits WHERE status = 'pending'");
    db.transaction(() => {
      for (const record of fromRows<StarterKitRecord>(pending.all())) {
        this.#rewrite(interrupted(record));
      }
    });
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many kits the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  find(userId: string): StarterKitRecord | undefined {
    return fromRow(this.#find.get(userId));
  }

  claim(
    userId: string,
    address: Address,
    dailyCap: number,
    now: Date,
    ipLimit?: StarterKitIpLimit,
  ): StarterKitClaim {
    return this.#db.transaction((): StarterKitClaim => {
      if (this.#find.get(userId)) return 'exists';
      const start = new Date(`${utcDay(now)}T00:00:00.000Z`);
      const end = new Date(start.getTime() + DAY_MS);
      const ipHash = ipLimit ? hashIp(ipLimit.ip) : undefined;
      const counts = this.#countDay.get(ipHash ?? null, start.toISOString(), end.toISOString())!;
      if (Number(counts['today']) >= dailyCap) return 'capped';
      if (ipLimit && Number(counts['from_ip']) >= ipLimit.cap) return 'ip_capped';
      this.#insert.run(...row(pendingKit(userId, address, now, ipHash)));
      return 'claimed';
    });
  }

  update(userId: string, patch: Partial<Omit<StarterKitRecord, 'userId'>>, now: Date): void {
    this.#db.transaction(() => {
      const record = fromRow<StarterKitRecord>(this.#find.get(userId));
      if (!record) return;
      this.#rewrite({ ...record, ...patch, updatedAt: now });
    });
  }

  /** Insert or replace by user id. For `state/db/state-import.ts` only. */
  put(record: StarterKitRecord): void {
    this.#upsert.run(...row(record));
  }

  /** Every record, in insertion order. For the import's verification. */
  async listAll(): Promise<StarterKitRecord[]> {
    return fromRows(this.#all.all());
  }

  #rewrite(record: StarterKitRecord): void {
    const [userId, ...values] = row(record);
    this.#update.run(...values, userId!);
  }
}
