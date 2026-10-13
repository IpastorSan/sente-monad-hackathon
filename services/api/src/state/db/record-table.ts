// One keyed table of whole records (SEN-205), for the stores whose only lookup
// is their key: get, upsert, delete and the full list, in insertion order.
//
// The sealed stores (credit keys, agent secrets, user venue secrets) use it as
// their ciphertext layer: it moves the file's sealed records in and out as they
// are, so the import can copy and verify them without `AGENT_SECRETS_KEY`, and
// the store on top is the only thing that ever holds the key.
//
// Erasable syntax and `.ts` specifiers (CLAUDE.md gotcha 10).

import type { SQLInputValue, StatementSync } from 'node:sqlite';

import { fromRow, fromRows, upsertSql } from './row.ts';
import type { SenteDb } from './sente-db.ts';

export class RecordTable<T> {
  readonly #db: SenteDb;
  readonly #row: (record: T) => SQLInputValue[];
  readonly #upsert: StatementSync;
  readonly #get: StatementSync;
  readonly #delete: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  /**
   * `columns` start with `key`; `row(record)` gives their values in that order,
   * ending with the record's `toDataJson`.
   */
  constructor(
    db: SenteDb,
    table: string,
    columns: readonly string[],
    row: (record: T) => SQLInputValue[],
  ) {
    const key = columns[0]!;
    this.#db = db;
    this.#row = row;
    this.#upsert = db.prepare(upsertSql(table, columns, key));
    this.#get = db.prepare(`SELECT data FROM ${table} WHERE ${key} = ?`);
    this.#delete = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
    this.#all = db.prepare(`SELECT data FROM ${table} ORDER BY rowid`);
    this.#count = db.prepare(`SELECT count(*) AS n FROM ${table}`);
  }

  get path(): string {
    return this.#db.path;
  }

  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  get(key: string): T | undefined {
    return fromRow(this.#get.get(key));
  }

  /** Insert or replace by key. */
  put(record: T): void {
    this.#upsert.run(...this.#row(record));
  }

  delete(key: string): void {
    this.#delete.run(key);
  }

  all(): T[] {
    return fromRows(this.#all.all());
  }

  /** {@link all}, in the shape `state/db/state-import.ts` verifies against. */
  async listAll(): Promise<T[]> {
    return this.all();
  }
}
