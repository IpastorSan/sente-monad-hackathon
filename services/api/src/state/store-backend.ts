// Which persistence the stores use under `STATE_DIR` (SEN-205).
//
// `STORE_BACKEND=file` (the default, and what production ran before SEN-205):
// one JSON/JSONL file per store, `state/json-file.ts`. `STORE_BACKEND=sqlite`:
// `<STATE_DIR>/sente.db`, `state/db/sente-db.ts`, for every store that has a
// SQLite implementation; a store that has not been converted yet keeps its file
// under either value. Anything else refuses to boot: a typo that silently fell
// back to `file` would look like a working API reading the wrong store.
//
// Without `STATE_DIR` the value is irrelevant — every store stays in memory.
//
// Erasable syntax only (CLAUDE.md gotcha 10): the import script reads this.

import { join } from 'node:path';

import type { SenteDb } from './db/sente-db.ts';

export const STORE_BACKEND_VAR = 'STORE_BACKEND';

export const STORE_BACKENDS = ['file', 'sqlite'] as const;
export type StoreBackend = (typeof STORE_BACKENDS)[number];

type Env = Record<string, string | undefined>;

/** The configured backend; `file` when unset. Throws on an unknown value. */
export function storeBackend(env: Env = process.env): StoreBackend {
  const raw = env[STORE_BACKEND_VAR]?.trim();
  if (!raw) return 'file';
  if ((STORE_BACKENDS as readonly string[]).includes(raw)) return raw as StoreBackend;
  throw new Error(
    `${STORE_BACKEND_VAR}=${JSON.stringify(raw)} is not a store backend. Use "file" ` +
      `(one JSON file per store under STATE_DIR, the default) or "sqlite" ` +
      `(<STATE_DIR>/sente.db). Refusing to boot rather than guess which stores to read.`,
  );
}

/** What a store provider needs to pick an implementation: `StateDirLease.dir` and `SenteDbLease.db`. */
export interface StoreSelector {
  /** `STATE_DIR`, resolved; `undefined` keeps every store in memory. */
  readonly dir: string | undefined;
  /** The open database, only under `STORE_BACKEND=sqlite` with a `STATE_DIR`. */
  readonly db: SenteDb | undefined;
}

export interface StoreChoice<T> {
  memory: () => T;
  /** Gets `<STATE_DIR>/<file>`. */
  file: (path: string) => T;
  sqlite: (db: SenteDb) => T;
}

/**
 * The switch, in one place: every converted store's provider is
 * `selectStore(lease, 'agents.json', { memory, file, sqlite })`. A store with no
 * SQLite implementation yet passes `sqlite: undefined`-free `file` only through
 * `selectFileStore` and keeps its file under both backends.
 */
export function selectStore<T>(lease: StoreSelector, file: string, choice: StoreChoice<T>): T {
  if (lease.db) return choice.sqlite(lease.db);
  return selectFileStore(lease, file, choice);
}

/** The pre-SEN-205 switch: in memory without `STATE_DIR`, else the file. */
export function selectFileStore<T>(
  lease: Pick<StoreSelector, 'dir'>,
  file: string,
  choice: Pick<StoreChoice<T>, 'memory' | 'file'>,
): T {
  return lease.dir ? choice.file(join(lease.dir, file)) : choice.memory();
}
