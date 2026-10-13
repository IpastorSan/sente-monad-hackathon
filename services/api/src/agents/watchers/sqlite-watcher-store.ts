// The watcher store, in SQLite (SEN-205).
//
// Same semantics as `InMemoryWatcherStore` and `FileWatcherStore`: one set per
// agent, replaced whole by `put`, copies in and out. The spec beside them runs
// all three through one table.
//
// Schema: `state/db/migrations/004-watchers.ts`. Every read decodes the row, so
// `peek` hands back a fresh object rather than the stored one; the scheduler's
// hot path reads a few small rows a tick, and a caller that mutated what
// `peek` returned would still change nothing stored.
//
// Erasable syntax and `.ts` specifiers, so the import script can load it under
// node's type stripping (CLAUDE.md gotcha 10).

import type { StatementSync } from 'node:sqlite';

import { fromRow, fromRows, toDataJson, upsertSql } from '../../state/db/row.ts';
import type { SenteDb } from '../../state/db/sente-db.ts';
import type { WatcherSet, WatcherStore } from './watcher-store.ts';

const TABLE = 'agent_watchers';
const COLUMNS = ['agent_id', 'updated_at', 'data'] as const;

function row(set: WatcherSet): string[] {
  return [set.agentId, new Date(set.updatedAt).toISOString(), toDataJson(set)];
}

export class SqliteWatcherStore implements WatcherStore {
  readonly #db: SenteDb;
  readonly #upsert: StatementSync;
  readonly #get: StatementSync;
  readonly #delete: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'agent_id'));
    this.#get = db.prepare(`SELECT data FROM ${TABLE} WHERE agent_id = ?`);
    this.#delete = db.prepare(`DELETE FROM ${TABLE} WHERE agent_id = ?`);
    this.#all = db.prepare(`SELECT data FROM ${TABLE} ORDER BY rowid`);
    this.#count = db.prepare(`SELECT count(*) AS n FROM ${TABLE}`);
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many agents have a watcher set. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  get(agentId: string): WatcherSet | undefined {
    return fromRow<WatcherSet>(this.#get.get(agentId));
  }

  peek(agentId: string): Readonly<WatcherSet> | undefined {
    return this.get(agentId);
  }

  put(set: WatcherSet): void {
    this.#upsert.run(...row(set));
  }

  delete(agentId: string): void {
    this.#delete.run(agentId);
  }

  /** Every set, in the order first stored. For `state/db/state-import.ts`. */
  listAll(): Promise<WatcherSet[]> {
    return Promise.resolve(fromRows<WatcherSet>(this.#all.all()));
  }
}
