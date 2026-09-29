import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';

import { STATE_DIR_VAR } from './json-file';
import {
  STATE_DIR_LOCK_FILE,
  StateDirLockedError,
  acquireStateDirLock,
  type StateDirLock,
} from './state-dir-lock';
import { StateDirLease, StateModule } from './state.module';

/** A pid that certainly belonged to a process on this host and certainly is gone. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (!child.pid) throw new Error('could not spawn a child to get a dead pid');
  return child.pid;
}

describe('acquireStateDirLock (SEN-161)', () => {
  let dir: string;
  const held: StateDirLock[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-state-lock-'));
  });

  afterEach(() => {
    for (const lock of held.splice(0)) lock.release();
    rmSync(dir, { recursive: true, force: true });
  });

  const take = (options?: Parameters<typeof acquireStateDirLock>[1]): StateDirLock => {
    const lock = acquireStateDirLock(dir, options);
    held.push(lock);
    return lock;
  };

  it('writes the owner (pid + hostname) into <dir>/api.lock', () => {
    const lock = take();
    expect(lock.path).toBe(join(dir, STATE_DIR_LOCK_FILE));
    const owner = JSON.parse(readFileSync(lock.path, 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, hostname: hostname() });
  });

  it('refuses a second writer while the first process is alive, naming the holder', () => {
    take();
    // A second process on this host: a different pid, and ours is alive.
    let error: unknown;
    try {
      take({ pid: process.pid + 100_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StateDirLockedError);
    expect((error as StateDirLockedError).holder?.pid).toBe(process.pid);
    expect((error as Error).message).toContain(`pid ${process.pid} on host ${hostname()}`);
    expect((error as Error).message).toContain('still running');
    // The refusal leaves the holder's lock alone.
    expect(JSON.parse(readFileSync(join(dir, STATE_DIR_LOCK_FILE), 'utf8')).pid).toBe(process.pid);
  });

  it('refuses a lock held on another host, even when that pid is dead here', () => {
    take({ hostname: 'other-box', isAlive: () => false });
    expect(() => take({ isAlive: () => false })).toThrow(/host other-box.*another host holds it/);
  });

  it('recovers a stale lock whose pid is dead on this host', () => {
    const dead = deadPid();
    writeFileSync(
      join(dir, STATE_DIR_LOCK_FILE),
      JSON.stringify({ pid: dead, hostname: hostname(), acquiredAt: '2026-01-01T00:00:00.000Z' }),
    );
    const lock = take();
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid);
  });

  it('treats its own pid on the same host as a previous incarnation (pid 1 in a container)', () => {
    writeFileSync(
      join(dir, STATE_DIR_LOCK_FILE),
      JSON.stringify({ pid: 1, hostname: 'sente-api', acquiredAt: '2026-01-01T00:00:00.000Z' }),
    );
    const lock = take({ pid: 1, hostname: 'sente-api', isAlive: () => true });
    expect(lock.owner.pid).toBe(1);
  });

  it('refuses a lock file it cannot read rather than guessing it is stale', () => {
    writeFileSync(join(dir, STATE_DIR_LOCK_FILE), 'not json');
    expect(() => take()).toThrow(/unreadable lock file/);
  });

  it('releases on close, so the next process can start', () => {
    const lock = take();
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(() => take({ pid: process.pid + 100_000 })).not.toThrow();
  });

  it('does not delete a lock someone else took after ours was removed by hand', () => {
    const lock = take();
    rmSync(lock.path);
    take({ pid: process.pid + 100_000 });
    lock.release();
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid + 100_000);
  });
});

describe('StateDirLease (SEN-161)', () => {
  let dir: string;
  const previous = process.env[STATE_DIR_VAR];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-state-lease-'));
    process.env[STATE_DIR_VAR] = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[STATE_DIR_VAR];
    else process.env[STATE_DIR_VAR] = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const boot = () => Test.createTestingModule({ imports: [StateModule] }).compile();

  it('holds the lock for the app and releases it on close', async () => {
    const app = await boot();
    expect(app.get(StateDirLease).dir).toBe(dir);
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(true);
    await app.close();
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(false);
  });

  it('takes nothing when STATE_DIR is unset', async () => {
    delete process.env[STATE_DIR_VAR];
    const app = await boot();
    expect(app.get(StateDirLease).dir).toBeUndefined();
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(false);
    await app.close();
  });
});
