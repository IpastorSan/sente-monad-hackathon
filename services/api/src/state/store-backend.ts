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

import { Logger } from '@nestjs/common';
import { join } from 'node:path';

import type { SenteDb } from './db/sente-db';

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

/** What a store provider needs to pick an implementation: `SenteDbLease` is one. */
export interface StoreSelector {
  /** `STATE_DIR`, resolved; `undefined` keeps every store in memory. */
  readonly dir: string | undefined;
  /** The open database, only under `STORE_BACKEND=sqlite` with a `STATE_DIR`. */
  readonly db: SenteDb | undefined;
}

/** What a persistent store reports at boot: where it is and how many records it holds. */
export interface Persisted {
  readonly path: string;
  readonly size: number;
}

export interface StoreChoice<T> {
  memory: () => T;
  /** Gets `<STATE_DIR>/<file>`. */
  file: (path: string) => T & Persisted;
  sqlite: (db: SenteDb) => T & Persisted;
}

/**
 * The switch, in one place: every converted store's provider is
 * `selectStore(lease, 'agents.json', 'agent(s)', { memory, file, sqlite })`,
 * and the persistent choices are logged here so each module does not write
 * its own line.
 */
export function selectStore<T>(
  lease: StoreSelector,
  file: string,
  noun: string,
  choice: StoreChoice<T>,
): T {
  if (!lease.dir) return choice.memory();
  const store = lease.db ? choice.sqlite(lease.db) : choice.file(join(lease.dir, file));
  Logger.log(`${store.size} ${noun} in ${store.path}`, 'StateStore');
  return store;
}
