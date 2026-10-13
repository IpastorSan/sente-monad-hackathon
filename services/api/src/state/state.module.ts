import { Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';

import { SenteDb, senteDbPath } from './db/sente-db';
import { stateDir } from './json-file';
import { acquireStateDirLock, type StateDirLock } from './state-dir-lock';
import { storeBackend, type StoreBackend, type StoreSelector } from './store-backend';

/**
 * This process's claim on `STATE_DIR` (SEN-161): the single-writer lock, taken
 * when Nest constructs it and released on shutdown.
 *
 * Every provider that opens a file under `STATE_DIR` injects this, even the
 * ones that never read it, because injection is what orders construction: Nest
 * builds a dependency before its dependents, so the lock is held before any
 * store has loaded, let alone written, a file. A second API process fails here
 * with `StateDirLockedError` instead of silently clobbering the first.
 *
 * With `STATE_DIR` unset there is nothing on disk to share, and no lock.
 */
@Injectable()
export class StateDirLease implements OnApplicationShutdown {
  readonly dir: string | undefined;
  private readonly lock: StateDirLock | undefined;

  constructor() {
    this.dir = stateDir();
    if (!this.dir) return;
    this.lock = acquireStateDirLock(this.dir);
    Logger.log(`Holding ${this.lock.path} (pid ${this.lock.owner.pid})`, 'StateDir');
  }

  onApplicationShutdown(): void {
    this.lock?.release();
  }
}

/**
 * The process's SQLite handle (SEN-205): `<STATE_DIR>/sente.db`, open only under
 * `STORE_BACKEND=sqlite` with a `STATE_DIR`, otherwise `db` is `undefined` and
 * every store keeps its JSON file (or memory). Injects `StateDirLease` so the
 * lock is held before the database opens — the same ordering trick the stores
 * use — and so a store provider can inject this alone (`selectStore` reads
 * `dir` and `db` from it). Migrations run here, at boot, before any store.
 * Closed (with a WAL checkpoint) on shutdown.
 */
@Injectable()
export class SenteDbLease implements OnApplicationShutdown, StoreSelector {
  readonly dir: string | undefined;
  readonly backend: StoreBackend;
  readonly db: SenteDb | undefined;

  constructor(lease: StateDirLease) {
    this.dir = lease.dir;
    this.backend = storeBackend();
    if (this.backend !== 'sqlite' || !this.dir) return;
    this.db = SenteDb.open(senteDbPath(this.dir));
    Logger.log(`Opened ${this.db.path} (schema v${this.db.schemaVersion})`, 'StateDb');
  }

  onApplicationShutdown(): void {
    this.db?.close();
  }
}

/**
 * Imported by each module that owns a file-backed store. Nest instantiates a
 * static module once however many modules import it, so this is one lease —
 * one lock, one database — for the whole directory.
 */
@Module({
  providers: [StateDirLease, SenteDbLease],
  exports: [StateDirLease, SenteDbLease],
})
export class StateModule {}
