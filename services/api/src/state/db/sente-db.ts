// One SQLite database for the API's state (SEN-205).
//
// `<STATE_DIR>/sente.db`, opened through `node:sqlite` — no native module to
// build, and the Node in the image (26.10) ships SQLite 3.53. It replaces the
// per-store JSON files of `state/json-file.ts` one store at a time, behind
// `STORE_BACKEND=sqlite` (`state/store-backend.ts`); with the default `file`
// nothing here runs.
//
// ## Why these settings
//
// - `journal_mode = WAL`: readers never block the writer and a crash mid-commit
//   leaves the last committed state, which is what the JSON files' write-temp-
//   then-rename gave us. A WAL database is three files (`sente.db`, `-wal`,
//   `-shm`): copy it with `backupTo` (`VACUUM INTO`), never with `cp` alone.
// - `synchronous = FULL`: the WAL is fsynced on every commit. NORMAL would
//   survive a process crash but could lose the last commits to a power cut, and
//   the records here are exactly the ones whose loss mints a second Privy wallet
//   (SEN-48). The file stores fsync every write today; writes are tens per hour,
//   so the extra fsync costs nothing we can measure.
// - `foreign_keys = ON`: SQLite leaves it off per connection by default.
// - `busy_timeout`: a second connection (the import script, a backup) waits for
//   the lock instead of failing at once. One API process per STATE_DIR still
//   holds (`StateDirLease`); this is for the tools that run while it is stopped.
//
// ## Transactions
//
// `transaction(fn)` runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back
// on a throw. A nested call joins the outer transaction through a SAVEPOINT, so
// a service can wrap two stores' writes in one `transaction` and have them land
// or vanish together. `fn` must be synchronous: `node:sqlite` is, and a Promise
// returned from it would be committed before its work ran, so it is refused.
//
// Erasable syntax only, and `.ts` specifiers: `scripts/state-import-sqlite.ts`
// loads this under node's type stripping (CLAUDE.md gotcha 10). Nest wiring is
// in `state/state.module.ts`.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { MIGRATIONS, type Migration } from './migrations/index.ts';

/** The database's name inside `STATE_DIR`. */
export const SENTE_DB_FILE = 'sente.db';

/** `<dir>/sente.db`. */
export function senteDbPath(dir: string): string {
  return join(resolve(dir), SENTE_DB_FILE);
}

/** `SenteDb.open(IN_MEMORY)`: a private, empty database that dies with the process. For specs. */
export const IN_MEMORY = ':memory:';

export class SenteDb {
  /** The file behind this database, or `:memory:`. */
  readonly path: string;
  readonly #db: DatabaseSync;
  /** 0 outside a transaction; the savepoint nesting depth inside one. */
  #depth = 0;
  #closed = false;

  /** Use {@link SenteDb.open}. */
  constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /**
   * Open (creating if needed) the database at `path`, set the pragmas, and
   * apply every migration not yet recorded in `schema_migrations`. A database
   * whose recorded migrations disagree with `migrations` fails here, at boot.
   */
  static open(path: string, migrations: readonly Migration[] = MIGRATIONS): SenteDb {
    const resolved = path === IN_MEMORY ? path : resolve(path);
    if (resolved !== IN_MEMORY) mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    const raw = new DatabaseSync(resolved);
    const db = new SenteDb(resolved, raw);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = FULL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA busy_timeout = 5000');
      db.migrate(migrations);
    } catch (error) {
      raw.close();
      throw error;
    }
    return db;
  }

  /**
   * Apply the migrations not yet applied, in one transaction. Idempotent: a
   * second call applies nothing. Returns the ids applied by this call.
   */
  migrate(migrations: readonly Migration[] = MIGRATIONS): number[] {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
    );
    return this.transaction(() => {
      const recorded = new Map<number, string>();
      for (const row of this.#db.prepare('SELECT id, name FROM schema_migrations').all()) {
        recorded.set(Number(row['id']), String(row['name']));
      }
      const record = this.#db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
      );
      const applied: number[] = [];
      let expected = 1;
      for (const migration of migrations) {
        if (migration.id !== expected) {
          throw new Error(
            `migration ${migration.id} (${migration.name}) is out of order: expected id ${expected}`,
          );
        }
        expected += 1;
        const name = recorded.get(migration.id);
        if (name !== undefined) {
          if (name !== migration.name) {
            throw new Error(
              `${this.path} has migration ${migration.id} recorded as "${name}" but the code ` +
                `says "${migration.name}". A migration that has run is never edited: add a new one.`,
            );
          }
          continue;
        }
        this.#db.exec(migration.sql);
        record.run(migration.id, migration.name, new Date().toISOString());
        applied.push(migration.id);
      }
      for (const id of recorded.keys()) {
        if (id >= expected) {
          throw new Error(
            `${this.path} was written by a newer build: it records migration ${id}, ` +
              `which this code does not have. Deploy the newer build, or restore a backup.`,
          );
        }
      }
      return applied;
    });
  }

  /** The highest migration id recorded, or 0 on an empty database. */
  get schemaVersion(): number {
    const row = this.#db.prepare('SELECT max(id) AS v FROM schema_migrations').get();
    return Number(row?.['v'] ?? 0);
  }

  /** A prepared statement. Prepare once per store, in its constructor. */
  prepare(sql: string): StatementSync {
    return this.#db.prepare(sql);
  }

  /** Run one or more statements with no result. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /**
   * Run `fn` atomically. See the header: nested calls join the outer
   * transaction, a throw rolls back what `fn` did (and only that, when nested),
   * and `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    if (this.#depth === 0) {
      this.#db.exec('BEGIN IMMEDIATE');
      this.#depth = 1;
      try {
        const result = refuseThenable(fn());
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#rollback('ROLLBACK');
        throw error;
      } finally {
        this.#depth = 0;
      }
    }
    const savepoint = `sp${this.#depth}`;
    this.#db.exec(`SAVEPOINT ${savepoint}`);
    this.#depth += 1;
    try {
      const result = refuseThenable(fn());
      this.#db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#rollback(`ROLLBACK TO ${savepoint}`);
      this.#rollback(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * Fold the WAL back into the main file. Run at shutdown so the next process
   * (or a plain copy of `sente.db` taken while nothing runs) sees everything.
   */
  checkpoint(): void {
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * A consistent copy of the whole database at `destination` (`VACUUM INTO`),
   * safe while this process keeps writing. The one correct way to back up a
   * WAL database that is in use.
   */
  backupTo(destination: string): void {
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.#db.prepare('VACUUM INTO ?').run(target);
  }

  /** Checkpoint and close. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.path !== IN_MEMORY) this.checkpoint();
    } finally {
      this.#db.close();
    }
  }

  /** SQLite may already have rolled back on its own (SQLITE_FULL, …); that is not an error here. */
  #rollback(sql: string): void {
    try {
      this.#db.exec(sql);
    } catch {
      // already rolled back
    }
  }
}

function refuseThenable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && 'then' in value) {
    throw new Error(
      'SenteDb.transaction(fn): fn returned a Promise. The transaction would commit before ' +
        'the work ran; make fn synchronous (node:sqlite is).',
    );
  }
  return value;
}
