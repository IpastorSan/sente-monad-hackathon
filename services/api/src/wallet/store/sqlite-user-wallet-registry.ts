// The user-wallet registry, in SQLite (SEN-205).
//
// Same semantics as `InMemoryUserWalletRegistry` and `FileUserWalletRegistry`
// — first-write-wins on `userId`, a different device key refused — and the
// spec beside the file registry runs all three through one table so they
// cannot drift apart. The write lands in its own transaction BEFORE `bind`
// answers, as the file registry's write-through does: a caller told
// `created: true` has a Privy wallet in hand, and a restart must not disagree.
//
// Schema: `state/db/migrations/001-agents-and-user-wallets.ts`; `data` holds
// the whole binding as tagged JSON (`state/db/row.ts`), the columns serve the
// lookups. Erasable syntax and `.ts` specifiers so the import script can load
// it under node's type stripping (CLAUDE.md gotcha 10).

import type { StatementSync } from 'node:sqlite';

import { fromRow, fromRows, insertSql, toDataJson, upsertSql } from '../../state/db/row.ts';
import type { SenteDb } from '../../state/db/sente-db.ts';
import type {
  UserWalletBindResult,
  UserWalletBinding,
  UserWalletRegistry,
} from './user-wallet-registry.ts';

const TABLE = 'user_wallets';
const COLUMNS = [
  'user_id',
  'wallet_id',
  'address',
  'device_public_key',
  'created_at',
  'data',
] as const;

/** The values of {@link COLUMNS}, in order. */
function row(binding: UserWalletBinding): string[] {
  return [
    binding.userId,
    binding.walletId,
    binding.address,
    binding.devicePublicKey,
    binding.createdAt.toISOString(),
    toDataJson(binding),
  ];
}

export class SqliteUserWalletRegistry implements UserWalletRegistry {
  readonly #db: SenteDb;
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #find: StatementSync;
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#insert = db.prepare(insertSql(TABLE, COLUMNS));
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'user_id'));
    this.#find = db.prepare('SELECT data FROM user_wallets WHERE user_id = ?');
    this.#all = db.prepare('SELECT data FROM user_wallets ORDER BY created_at, rowid');
    this.#count = db.prepare('SELECT count(*) AS n FROM user_wallets');
  }

  /** The database behind this registry. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many bindings the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  async find(userId: string): Promise<UserWalletBinding | undefined> {
    return fromRow(this.#find.get(userId));
  }

  async bind(binding: Omit<UserWalletBinding, 'createdAt'>): Promise<UserWalletBindResult> {
    return this.#db.transaction((): UserWalletBindResult => {
      const existing = fromRow<UserWalletBinding>(this.#find.get(binding.userId));
      if (existing) {
        // Exact string compare, as in the other two: both halves are the
        // canonical base64 SPKI DER `authorization-key.ts` produces.
        const sameKey = existing.devicePublicKey === binding.devicePublicKey;
        return sameKey ? { ok: true, binding: existing, created: false } : { ok: false, existing };
      }
      const created: UserWalletBinding = { ...binding, createdAt: new Date() };
      this.#insert.run(...row(created));
      return { ok: true, binding: created, created: true };
    });
  }

  /** Insert or replace by user id. For `state/db/state-import.ts` only. */
  put(binding: UserWalletBinding): void {
    this.#upsert.run(...row(binding));
  }

  /** Every binding, oldest first. For the import's verification. */
  async listAll(): Promise<UserWalletBinding[]> {
    return fromRows(this.#all.all());
  }
}
