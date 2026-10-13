// The agent store, in SQLite (SEN-205).
//
// Same semantics as `InMemoryAgentStore` and `FileAgentStore` — duplicate id
// and duplicate MCP token hash both rejected with the same messages, records
// copied in and out, `revoked` terminal — and the spec beside the file store
// runs all three through one table so they cannot drift apart.
//
// Schema: `state/db/migrations/001-agents-and-user-wallets.ts`. The columns
// exist for the lookups (`user_id`, `address_key`, `mcp_token_hash`, the
// `listActive` predicate, `created_at` for the order); `data` holds the whole
// record as the tagged JSON `state/json-file.ts` writes (`state/db/row.ts`),
// so a parsed mandate's bigint atoms and every `Date` come back as what they
// were, and a field added to `AgentRecord` persists with no change here.
//
// Erasable syntax and `.ts` specifiers, like `file-agent-store.ts`, so the
// import script can load it under node's type stripping (CLAUDE.md gotcha 10).

import type { StatementSync } from 'node:sqlite';

import {
  fromRow,
  fromRows,
  insertSql,
  toDataJson,
  updateSql,
  upsertSql,
} from '../../state/db/row.ts';
import type { SenteDb } from '../../state/db/sente-db.ts';
import { addressKey, type AgentPatch, type AgentRecord, type AgentStore } from './agent-store.ts';

const TABLE = 'agents';
const COLUMNS = [
  'id',
  'user_id',
  'address_key',
  'mcp_token_hash',
  'status',
  'archived_at',
  'created_at',
  'updated_at',
  'data',
] as const;

/** The values of {@link COLUMNS}, in order. */
function row(record: AgentRecord): (string | null)[] {
  return [
    record.id,
    record.userId,
    addressKey(record.address),
    record.mcpTokenHash,
    record.status,
    record.archivedAt ? record.archivedAt.toISOString() : null,
    record.createdAt.toISOString(),
    record.updatedAt.toISOString(),
    toDataJson(record),
  ];
}

const ORDER = 'ORDER BY created_at, rowid';

export class SqliteAgentStore implements AgentStore {
  readonly #db: SenteDb;
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #update: StatementSync;
  readonly #get: StatementSync;
  readonly #hasId: StatementSync;
  readonly #hasToken: StatementSync;
  readonly #byUser: StatementSync;
  readonly #active: StatementSync;
  readonly #all: StatementSync;
  readonly #byToken: StatementSync;
  readonly #byAddress: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb) {
    this.#db = db;
    this.#insert = db.prepare(insertSql(TABLE, COLUMNS));
    this.#upsert = db.prepare(upsertSql(TABLE, COLUMNS, 'id'));
    this.#update = db.prepare(updateSql(TABLE, COLUMNS, 'id'));
    this.#get = db.prepare('SELECT data FROM agents WHERE id = ?');
    this.#hasId = db.prepare('SELECT 1 FROM agents WHERE id = ?');
    this.#hasToken = db.prepare('SELECT 1 FROM agents WHERE mcp_token_hash = ?');
    this.#byUser = db.prepare(`SELECT data FROM agents WHERE user_id = ? ${ORDER}`);
    this.#active = db.prepare(
      `SELECT data FROM agents WHERE status = 'active' AND archived_at IS NULL ${ORDER}`,
    );
    this.#all = db.prepare(`SELECT data FROM agents ${ORDER}`);
    this.#byToken = db.prepare('SELECT data FROM agents WHERE mcp_token_hash = ?');
    // The in-memory store's address index keeps the LAST agent inserted at an address.
    this.#byAddress = db.prepare(
      'SELECT data FROM agents WHERE address_key = ? ORDER BY rowid DESC LIMIT 1',
    );
    this.#count = db.prepare('SELECT count(*) AS n FROM agents');
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many agents the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  async insert(record: AgentRecord): Promise<void> {
    this.#db.transaction(() => {
      if (this.#hasId.get(record.id)) throw new Error(`agent ${record.id} already exists`);
      if (this.#hasToken.get(record.mcpTokenHash)) throw new Error('MCP token hash collision');
      this.#insert.run(...row(record));
    });
  }

  /**
   * Insert or replace by id, keys included. For `state/db/state-import.ts`,
   * which re-runs safely because of it; nothing in the API calls this.
   */
  put(record: AgentRecord): void {
    this.#upsert.run(...row(record));
  }

  async get(id: string): Promise<AgentRecord | undefined> {
    return fromRow(this.#get.get(id));
  }

  async listByUser(userId: string): Promise<AgentRecord[]> {
    return fromRows(this.#byUser.all(userId));
  }

  async listActive(): Promise<AgentRecord[]> {
    return fromRows(this.#active.all());
  }

  async listAll(): Promise<AgentRecord[]> {
    return fromRows(this.#all.all());
  }

  async findByMcpTokenHash(hash: string): Promise<AgentRecord | undefined> {
    return fromRow(this.#byToken.get(hash));
  }

  async findByAddress(address: string): Promise<AgentRecord | undefined> {
    return fromRow(this.#byAddress.get(addressKey(address)));
  }

  async update(id: string, patch: AgentPatch): Promise<AgentRecord> {
    return this.#db.transaction(() => {
      const existing = fromRow<AgentRecord>(this.#get.get(id));
      if (!existing) throw new Error(`no agent ${id}`);
      const next: AgentRecord = { ...existing, ...structuredClone(patch) };
      const [, ...values] = row(next);
      this.#update.run(...values, id);
      return next;
    });
  }
}
