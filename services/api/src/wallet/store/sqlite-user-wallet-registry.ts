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
// the whole binding as tagged JSON (`state/json-file.ts`), the columns serve
// the lookups. Erasable syntax and `.ts` specifiers so the import script can
// load it under node's type stripping (CLAUDE.md gotcha 10).

import type { StatementSync } from 'node:sqlite';

import type { SenteDb } from '../../state/db/sente-db.ts';
import { decodeValue, encodeValue, type JsonValue } from '../../state/json-file.ts';
import type {
  UserWalletBindResult,
  UserWalletBinding,
  UserWalletRegistry,
} from './user-wallet-registry.ts';

const COLUMNS = 'user_id, wallet_id, address, device_public_key, created_at, data';

function row(binding: UserWalletBinding): [string, string, string, string, string, string] {
  return [
    binding.userId,
    binding.walletId,
    binding.address,
    binding.devicePublicKey,
    binding.createdAt.toISOString(),
    JSON.stringify(encodeValue(binding)),
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
    this.#insert = db.prepare(`INSERT INTO user_wallets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`);
    this.#upsert = db.prepare(
      `INSERT INTO user_wallets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ` +
        'ON CONFLICT (user_id) DO UPDATE SET wallet_id = excluded.wallet_id, ' +
        'address = excluded.address, device_public_key = excluded.device_public_key, ' +
        'created_at = excluded.created_at, data = excluded.data',
    );
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
    return this.#one(this.#find.get(userId));
  }

  async bind(binding: Omit<UserWalletBinding, 'createdAt'>): Promise<UserWalletBindResult> {
    return this.#db.transaction((): UserWalletBindResult => {
      const existing = this.#one(this.#find.get(binding.userId));
      if (existing) {
        // Exact string compare, as in the other two: both halves are the
        // canonical base64 SPKI DER `authorization-key.ts` produces.
        const sameKey = existing.devicePublicKey === binding.devicePublicKey;
        return sameKey ? { ok: true, binding: existing, created: false } : { ok: false, existing };
      }
      const created: UserWalletBinding = { ...binding, createdAt: new Date() };
      this.#insert.run(...row(created));
      return { ok: true, binding: this.#one(this.#find.get(binding.userId))!, created: true };
    });
  }

  /** Insert or replace by user id. For `state/db/state-import.ts` only. */
  put(binding: UserWalletBinding): void {
    this.#upsert.run(...row(binding));
  }

  /** Every binding, oldest first. For the import's verification. */
  async listAll(): Promise<UserWalletBinding[]> {
    return this.#all.all().map((found) => this.#one(found)!);
  }

  #one(found: Record<string, unknown> | undefined): UserWalletBinding | undefined {
    return found
      ? (decodeValue(JSON.parse(String(found['data'])) as JsonValue) as UserWalletBinding)
      : undefined;
  }
}
