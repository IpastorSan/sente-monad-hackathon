// One writer per `STATE_DIR` (SEN-161).
//
// Every file-backed store under `STATE_DIR` — the user-wallet registry and the
// agent store (SEN-48), the agent event log (SEN-65), the agents' encrypted
// Perpl keys (SEN-148) — loads its file ONCE at boot and from then on trusts
// its own memory: each write replaces or appends to the file from what this
// process holds. Two processes on the same directory therefore do not share
// state, they overwrite each other's: the second API's next `save` drops every
// agent the first one hired since boot, and two appenders interleave the event
// log. Nothing errors; records just vanish.
//
// Moving to a shared database would fix that for real. Until the API needs a
// second replica it is not worth it, so the rule is enforced instead: whoever
// boots first takes `<STATE_DIR>/api.lock`, and a second process refuses to
// start, naming the holder.
//
// ## Stale locks
//
// A lock outlives a process that died without releasing it (SIGKILL, OOM, a
// power cut). It is taken over ONLY when the holder is provably dead: same
// hostname (a pid means nothing on another host, and STATE_DIR may be a shared
// volume) and `kill(pid, 0)` answers ESRCH. Anything else — another host, a pid
// that is alive, a lock file that does not parse — refuses, because starting a
// second writer is the silent failure this exists to prevent, and a refusal
// costs the operator one `rm` once they have checked.
//
// A holder pid equal to our own pid on the same host is also stale: it is a
// previous incarnation of this container (node runs as pid 1 in the image, and
// compose pins the hostname), since this process has not taken the lock yet.
//
// This file holds erasable syntax only and imports nothing outside node, so the
// scripts that write STATE_DIR under node's type stripping can take the same
// lock (CLAUDE.md gotcha 10).

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join, resolve } from 'node:path';

/** The lock file's name inside `STATE_DIR`. */
export const STATE_DIR_LOCK_FILE = 'api.lock';

/** Who holds the lock, as written into the lock file. */
export interface StateDirLockOwner {
  pid: number;
  hostname: string;
  /** ISO timestamp; for the operator reading the refusal, never compared. */
  acquiredAt: string;
}

export interface StateDirLockOptions {
  /** Defaults to this process's. Overridable so the specs can play a second process. */
  pid?: number;
  hostname?: string;
  /** Whether `pid` is a live process on this host. Defaults to `kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

/** A second writer tried to take a directory someone else holds. */
export class StateDirLockedError extends Error {
  readonly lockPath: string;
  readonly holder: StateDirLockOwner | undefined;

  constructor(lockPath: string, holder: StateDirLockOwner | undefined, reason: string) {
    const who = holder
      ? `pid ${holder.pid} on host ${holder.hostname} (since ${holder.acquiredAt})`
      : 'an unreadable lock file';
    super(
      `STATE_DIR is locked by ${who}: ${reason}. Only one API process may write ` +
        `STATE_DIR at a time (SEN-161) — a second one silently overwrites the first one's ` +
        `agents, wallet bindings and event log. Stop the other process, or, if you are SURE ` +
        `nothing else uses this directory, delete ${lockPath} and start again.`,
    );
    this.name = 'StateDirLockedError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

/** A held lock. `release` is idempotent and also runs on process exit. */
export class StateDirLock {
  readonly path: string;
  readonly owner: StateDirLockOwner;
  private released = false;
  private readonly onExit: () => void;

  constructor(path: string, owner: StateDirLockOwner) {
    this.path = path;
    this.owner = owner;
    // A crash that still runs `exit` handlers (an uncaught throw, process.exit)
    // releases too, so only a hard kill leaves a stale lock behind.
    this.onExit = () => this.release();
    process.once('exit', this.onExit);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    process.removeListener('exit', this.onExit);
    // Only remove the file if it is still ours: an operator who deleted it by
    // hand may already have started another process that took it.
    const current = readOwner(this.path);
    if (current?.pid === this.owner.pid && current.hostname === this.owner.hostname) {
      rmSync(this.path, { force: true });
    }
  }
}

/**
 * Take `<dir>/api.lock`, or throw `StateDirLockedError` naming the holder.
 *
 * The lock file is written in full to a temp file first and then hard-linked
 * into place: `link` fails with EEXIST atomically when the name is taken, so
 * two racing processes cannot both win, and the lock file is never observed
 * empty or half-written (which would be unparseable and so never recoverable).
 */
export function acquireStateDirLock(dir: string, options: StateDirLockOptions = {}): StateDirLock {
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? osHostname();
  const isAlive = options.isAlive ?? processIsAlive;
  const path = join(resolve(dir), STATE_DIR_LOCK_FILE);
  const owner: StateDirLockOwner = { pid, hostname: host, acquiredAt: new Date().toISOString() };

  mkdirSync(resolve(dir), { recursive: true, mode: 0o700 });
  const temp = `${path}.${pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = openSync(temp, 'wx', 0o600);
  try {
    writeSync(handle, `${JSON.stringify(owner)}\n`);
  } finally {
    closeSync(handle);
  }

  try {
    // Two attempts: the second only after removing a provably stale lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temp, path);
        return new StateDirLock(path, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = readOwner(path);
      if (!holder) throw new StateDirLockedError(path, undefined, 'its owner cannot be read');
      if (holder.hostname !== host) {
        throw new StateDirLockedError(path, holder, 'another host holds it');
      }
      if (holder.pid !== pid && isAlive(holder.pid)) {
        throw new StateDirLockedError(path, holder, 'that process is still running');
      }
      if (attempt === 1) {
        // Someone re-took it between our removal and our link: a live race, not a stale lock.
        throw new StateDirLockedError(path, holder, 'another process took it while starting');
      }
      rmSync(path, { force: true });
    }
    throw new Error('unreachable');
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The owner recorded in a lock file, or `undefined` when it is missing or does not parse. */
function readOwner(path: string): StateDirLockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const owner = parsed as Partial<StateDirLockOwner> | null;
  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    typeof owner.hostname !== 'string' ||
    typeof owner.acquiredAt !== 'string'
  ) {
    return undefined;
  }
  return owner as StateDirLockOwner;
}

/**
 * `kill(pid, 0)` sends nothing and only checks. ESRCH is the one answer that
 * proves the process is gone; EPERM means it exists under another user, so
 * anything but ESRCH counts as alive.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
