import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { backupConfig, BACKUPS_DIR, takeBackup, type BackupConfig } from './db/backups';
import { SenteDb, senteDbPath } from './db/sente-db';
import { JsonRecordFile, stateDir } from './json-file';
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
 *
 * Refuses to boot under `sqlite` with an empty `user_wallets` table while
 * `user-wallets.json` holds bindings: that is a cut-over whose import never
 * ran, and serving it would mint a second Privy wallet for every returning
 * user (SEN-48).
 *
 * Checkpointed on shutdown but closed only when the process exits
 * ({@link closeAtExit}): an agent run still in flight after the HTTP server
 * stops keeps writing its transcript and events, and those writes must land.
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
    try {
      refuseUnimportedState(this.db, this.dir);
    } catch (error) {
      this.db.close();
      throw error;
    }
    Logger.log(`Opened ${this.db.path} (schema v${this.db.schemaVersion})`, 'StateDb');
  }

  onApplicationShutdown(): void {
    if (!this.db) return;
    try {
      this.db.checkpoint();
    } catch (error) {
      Logger.warn(`checkpoint of ${this.db.path} at shutdown failed: ${String(error)}`, 'StateDb');
    }
    closeAtExit(this.db);
  }
}

/** The `user_wallets` table is empty but `user-wallets.json` is not: the import never ran. */
function refuseUnimportedState(db: SenteDb, dir: string): void {
  const rows = Number(db.prepare('SELECT count(*) AS n FROM user_wallets').get()!['n']);
  if (rows > 0) return;
  const file = join(dir, 'user-wallets.json');
  if (!existsSync(file) || new JsonRecordFile(file).load().length === 0) return;
  throw new Error(
    `STORE_BACKEND=sqlite but ${db.path} holds no wallet bindings while ${file} does: ` +
      'the JSON files were never imported. Stop, run the import (`node dist/state-import-sqlite.js` ' +
      'in the image, `pnpm --filter @sente/api run state:import-sqlite` locally), then start again; ' +
      'or set STORE_BACKEND=file. Refusing to boot rather than serve an empty registry ' +
      '(every returning user would get a second Privy wallet).',
  );
}

/** Databases a shut-down lease left open, closed (checkpoint included) as the process exits. */
const closingAtExit = new Set<SenteDb>();

/**
 * Close `db` when the process exits, not now: late writes after shutdown
 * still land. One `exit` listener for the process however many apps shut
 * down (specs boot many). `db.close()` is idempotent, so closing it earlier
 * (a spec's teardown) is harmless.
 */
export function closeAtExit(db: SenteDb): void {
  if (closingAtExit.size === 0) {
    process.once('exit', () => {
      for (const open of closingAtExit) {
        try {
          open.close();
        } catch {
          // exiting anyway; the WAL is replayed at the next open
        }
      }
      closingAtExit.clear();
    });
  }
  closingAtExit.add(db);
}

/**
 * Backs `sente.db` up on a timer (SEN-205): once right after boot, then every
 * `BACKUP_INTERVAL_MINUTES` (default 360; 0 turns them off), keeping the newest
 * `BACKUP_KEEP` (default 8) in `<STATE_DIR>/backups`. `state/db/backups.ts` has
 * the mechanics.
 *
 * Nothing here can stop the API: the first backup runs after the boot has
 * finished, not during it, and a failed backup is logged and retried at the
 * next tick. Inert under `STORE_BACKEND=file` and without a `STATE_DIR`, where
 * there is no database.
 */
@Injectable()
export class SenteDbBackups implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('StateDbBackup');
  private readonly db: SenteDb | undefined;
  private readonly dir: string | undefined;
  private readonly config: BackupConfig | undefined;
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Immediate | undefined;

  constructor(lease: SenteDbLease) {
    if (!lease.db || !lease.dir) return;
    this.db = lease.db;
    this.dir = join(lease.dir, BACKUPS_DIR);
    // Read only when there is a database to back up, so a bad value cannot
    // refuse a boot under `file`. Under `sqlite` it does refuse: a typo that
    // silently fell back to the default would look like a schedule it is not.
    this.config = backupConfig();
  }

  onApplicationBootstrap(): void {
    if (!this.config) return;
    if (this.config.intervalMinutes === 0) {
      this.logger.warn('BACKUP_INTERVAL_MINUTES=0: sente.db is not backed up');
      return;
    }
    const { intervalMinutes, keep } = this.config;
    this.logger.log(`Backing up every ${intervalMinutes} min to ${this.dir}, keeping ${keep}`);
    this.first = setImmediate(() => this.backup());
    this.timer = setInterval(() => this.backup(), intervalMinutes * 60_000);
    this.timer.unref();
  }

  /** Before any `onApplicationShutdown`, so no backup starts on a closed database. */
  onModuleDestroy(): void {
    if (this.first) clearImmediate(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }

  /** One backup now. Never throws. */
  backup(): void {
    if (!this.db || !this.dir || !this.config) return;
    try {
      const result = takeBackup(this.db, this.dir, this.config.keep);
      this.logger.log(
        `${result.path}: ${result.bytes} bytes in ${result.ms} ms` +
          (result.pruned.length ? `; pruned ${result.pruned.length} older` : ''),
      );
    } catch (error) {
      this.logger.error(
        `backup of ${this.db.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Imported by each module that owns a file-backed store. Nest instantiates a
 * static module once however many modules import it, so this is one lease —
 * one lock, one database — for the whole directory.
 */
@Module({
  providers: [StateDirLease, SenteDbLease, SenteDbBackups],
  exports: [StateDirLease, SenteDbLease],
})
export class StateModule {}
