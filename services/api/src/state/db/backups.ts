// Periodic copies of sente.db (SEN-205), under STORE_BACKEND=sqlite only.
//
// Each backup is `SenteDb.backupTo` (`VACUUM INTO`): one self-contained file,
// consistent while the API keeps writing, at
// `<STATE_DIR>/backups/sente-<UTC timestamp>.db`. The newest `BACKUP_KEEP` are
// kept and older ones deleted; only files matching the backup name are ever
// touched, so anything else put in the directory by hand stays.
//
// They live on the same disk as the database, so they cover a bad write, a bad
// migration or a bad deploy, not the loss of the disk: copy one off the box
// for that (docs/state.md, "Backups").
//
// Erasable syntax and `.ts` specifiers (CLAUDE.md gotcha 10).

import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SenteDb } from './sente-db.ts';

export const BACKUP_INTERVAL_VAR = 'BACKUP_INTERVAL_MINUTES';
export const BACKUP_KEEP_VAR = 'BACKUP_KEEP';
export const DEFAULT_BACKUP_INTERVAL_MINUTES = 360;
export const DEFAULT_BACKUP_KEEP = 8;

/** `<STATE_DIR>/<this>`. */
export const BACKUPS_DIR = 'backups';

const NAME = /^sente-\d{8}T\d{6}Z\.db$/;

export interface BackupConfig {
  /** 0: no periodic backups (and none at boot). */
  readonly intervalMinutes: number;
  readonly keep: number;
}

type Env = Record<string, string | undefined>;

/** The configured schedule. Throws on a value that is not a whole number in range. */
export function backupConfig(env: Env = process.env): BackupConfig {
  return {
    intervalMinutes: wholeNumber(env, BACKUP_INTERVAL_VAR, DEFAULT_BACKUP_INTERVAL_MINUTES, 0),
    keep: wholeNumber(env, BACKUP_KEEP_VAR, DEFAULT_BACKUP_KEEP, 1),
  };
}

function wholeNumber(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name}=${JSON.stringify(raw)} must be a whole number of at least ${min}`);
  }
  return value;
}

/** `sente-20261013T101500Z.db`: sorts as time sorts. */
export function backupFileName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `sente-${stamp}.db`;
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly ms: number;
  /** The backups deleted to keep `keep`. */
  readonly pruned: readonly string[];
}

/**
 * One backup of `db` into `dir`, then prune to the newest `keep`. Synchronous,
 * like `node:sqlite`: it holds the event loop for as long as `VACUUM INTO`
 * takes, which for this database is milliseconds.
 */
export function takeBackup(db: SenteDb, dir: string, keep: number, at = new Date()): BackupResult {
  const path = join(dir, backupFileName(at));
  const started = performance.now();
  db.backupTo(path);
  chmodSync(path, 0o600); // like the JSON files; VACUUM INTO creates it under the umask
  const ms = Math.round(performance.now() - started);
  return { path, bytes: statSync(path).size, ms, pruned: pruneBackups(dir, keep) };
}

/** Delete every backup in `dir` but the newest `keep`. Returns the paths deleted. */
export function pruneBackups(dir: string, keep: number): string[] {
  const names = readdirSync(dir)
    .filter((name) => NAME.test(name))
    .sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep)).map((name) => join(dir, name));
  for (const path of doomed) rmSync(path, { force: true });
  return doomed;
}
