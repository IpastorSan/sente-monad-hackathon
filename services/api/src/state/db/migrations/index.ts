// The migration registry (SEN-205): every schema change, in the order it runs.
//
// To add a store: write `NNN-<what>.ts` beside this file exporting a
// `Migration` whose `id` is the next integer, and append it here. Never edit a
// migration that has run anywhere (production included) — `SenteDb.migrate`
// refuses a recorded id whose name changed. A schema fix is a new migration.
//
// Erasable syntax only: the import script loads this under node's type
// stripping (CLAUDE.md gotcha 10).

import { migration as m001 } from './001-agents-and-user-wallets.ts';
import { migration as m004 } from './004-watchers.ts';
import type { Migration } from './migration.ts';

export type { Migration } from './migration.ts';

// MERGE: ids 2 and 3 belong to stores converted on sibling SEN-205 branches.
// These stand-ins only keep the sequence contiguous on this branch; the merge
// replaces both lines with the real `m002` and `m003` imports.
const m002: Migration = { id: 2, name: 'reserved-2', sql: 'SELECT 1' };
const m003: Migration = { id: 3, name: 'reserved-3', sql: 'SELECT 1' };

export const MIGRATIONS: readonly Migration[] = [m001, m002, m003, m004];
