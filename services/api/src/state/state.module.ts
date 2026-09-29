import { Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';

import { stateDir } from './json-file';
import { acquireStateDirLock, type StateDirLock } from './state-dir-lock';

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
 * Imported by each module that owns a file-backed store. Nest instantiates a
 * static module once however many modules import it, so this is one lease —
 * one lock — for the whole directory.
 */
@Module({
  providers: [StateDirLease],
  exports: [StateDirLease],
})
export class StateModule {}
