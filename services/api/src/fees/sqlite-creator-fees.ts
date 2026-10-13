// The creator fee ledger, in SQLite (SEN-205).
//
// Same rules as `FileCreatorFeeLedger` — `newAccrual`, `newPayout` and
// `totalsOf` decide for both — and `creator-fees.spec.ts` runs both through
// one table. Each accrual or payout checks and writes in one transaction.
// Amounts are summed in JS from `data`, not in SQL: they are bigints, and an
// 18-decimal asset's atoms overflow SQLite's 64-bit integers soon enough.
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`; `tx_key` is
// the hash lower-cased, so both duplicate checks are case-blind like the
// file's. Erasable syntax and `.ts` specifiers: the payout script and the
// import script load it under node's type stripping (gotcha 10).

import type { StatementSync } from 'node:sqlite';

import { fromRows, insertSql, toDataJson, upsertSql } from '../state/db/row.ts';
import type { SenteDb } from '../state/db/sente-db.ts';
import {
  newAccrual,
  newPayout,
  totalsOf,
  type CreatorFeeAccrual,
  type CreatorFeeLedger,
  type CreatorFeePayout,
  type CreatorFeeRecord,
  type CreatorFeeTotals,
  type NewAccrual,
  type NewPayout,
} from './creator-fees.ts';

const TABLE = 'creator_fees';
const COLUMNS = [
  'id',
  'kind',
  'creator_user_id',
  'agent_id',
  'asset',
  'tx_key',
  'at',
  'data',
] as const;

function row(record: CreatorFeeRecord): (string | null)[] {
  return [
    record.id,
    record.kind,
    record.creatorUserId,
    record.kind === 'accrued' ? record.agentId : null,
    record.asset,
    record.txHash.toLowerCase(),
    record.at.toISOString(),
    toDataJson(record),
  ];
}

export class SqliteCreatorFeeLedger implements CreatorFeeLedger {
  readonly #db: SenteDb;
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #accrued: StatementSync;
  readonly #txRecorded: StatementSync;
  readonly #byCreator: StatementSync;
  readonly #recent: StatementSync;
  readonly #creators: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#insert = db.prepare(insertSql(TABLE, COLUMNS));
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'id'));
    this.#accrued = db.prepare(
      "SELECT 1 FROM creator_fees WHERE tx_key = ? AND agent_id = ? AND asset = ? AND kind = 'accrued'",
    );
    this.#txRecorded = db.prepare('SELECT 1 FROM creator_fees WHERE tx_key = ?');
    this.#byCreator = db.prepare(
      'SELECT data FROM creator_fees WHERE creator_user_id = ? ORDER BY rowid',
    );
    // The file's stable sort by `at` descending: a tie keeps insertion order.
    this.#recent = db.prepare(
      'SELECT data FROM creator_fees WHERE creator_user_id = ? ORDER BY at DESC, rowid LIMIT ?',
    );
    this.#creators = db.prepare(
      'SELECT creator_user_id FROM creator_fees GROUP BY creator_user_id ORDER BY min(rowid)',
    );
    this.#all = db.prepare('SELECT data FROM creator_fees ORDER BY rowid');
    this.#count = db.prepare('SELECT count(*) AS n FROM creator_fees');
  }

  /** The database behind this ledger. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many records the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  accrue(input: NewAccrual): CreatorFeeAccrual | null {
    const record = newAccrual(input);
    if (!record) return null;
    return this.#db.transaction(() => {
      const key = input.txHash.toLowerCase();
      if (this.#accrued.get(key, input.agentId, input.asset)) return null;
      this.#insert.run(...row(record));
      return record;
    });
  }

  payout(input: NewPayout): CreatorFeePayout {
    return this.#db.transaction(() => {
      const txRecorded = this.#txRecorded.get(input.txHash.toLowerCase()) !== undefined;
      const record = newPayout(input, txRecorded, this.totals(input.creatorUserId));
      this.#insert.run(...row(record));
      return record;
    });
  }

  totals(creatorUserId: string): CreatorFeeTotals[] {
    return totalsOf(fromRows<CreatorFeeRecord>(this.#byCreator.all(creatorUserId)));
  }

  recent(creatorUserId: string, limit: number): CreatorFeeRecord[] {
    return fromRows(this.#recent.all(creatorUserId, limit));
  }

  creators(): string[] {
    return this.#creators.all().map((r) => String(r['creator_user_id']));
  }

  /** Insert or replace by id. For `state/db/state-import.ts` only. */
  put(record: CreatorFeeRecord): void {
    this.#upsert.run(...row(record));
  }

  /** Every record, in insertion order. For the import's verification. */
  async listAll(): Promise<CreatorFeeRecord[]> {
    return fromRows(this.#all.all());
  }
}
