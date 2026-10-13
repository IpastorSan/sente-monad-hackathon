// The agents' venue secrets, in SQLite and still sealed (SEN-205).
//
// Same rules as `FileAgentSecretStore`: AES-256-GCM under `AGENT_SECRETS_KEY`
// with the agent id bound in, every row decrypted at boot so a wrong key fails
// the boot instead of starting empty (which would re-enroll every agent and
// burn Perpl key slots), and credentials handed out sealed. The row holds the
// file's record exactly, so the import copies ciphertext and never the key
// (`agentSecretRows`). Nothing decrypted is kept in memory: each read unseals
// its row.
//
// Schema: `state/db/migrations/002-small-stores-and-secrets.ts`. Erasable
// syntax and `.ts` specifiers (gotcha 10).

import type { PerplCredentials } from '@sente/venues/perpl';

import { RecordTable } from '../../state/db/record-table.ts';
import { toDataJson } from '../../state/db/row.ts';
import type { SenteDb } from '../../state/db/sente-db.ts';
import type { AgentSecretStore } from './agent-secret-store.ts';
import {
  sealAgentSecret,
  unsealAgentSecret,
  type AgentSecretRecord,
} from './file-agent-secret-store.ts';

/** The `agent_secrets` rows, sealed: what the import copies, with no key. */
export function agentSecretRows(db: SenteDb): RecordTable<AgentSecretRecord> {
  return new RecordTable<AgentSecretRecord>(db, 'agent_secrets', ['agent_id', 'data'], (r) => [
    r.agentId,
    toDataJson(r),
  ]);
}

export class SqliteAgentSecretStore implements AgentSecretStore {
  readonly #rows: RecordTable<AgentSecretRecord>;
  readonly #key: Buffer;

  /** Decrypts every row once, so a wrong key or a tampered row fails the boot. */
  constructor(db: SenteDb, key: Uint8Array) {
    if (key.length !== 32) throw new Error('the agent secrets key must be 32 bytes');
    this.#key = Buffer.from(key);
    this.#rows = agentSecretRows(db);
    for (const record of this.#rows.all()) {
      unsealAgentSecret(this.#key, record, this.path).secretKey.fill(0);
    }
  }

  /** The database behind this store. Logged at boot. */
  get path(): string {
    return this.#rows.path;
  }

  /** How many agents' secrets the table holds. Logged at boot. */
  get size(): number {
    return this.#rows.size;
  }

  async getPerplCredentials(agentId: string): Promise<PerplCredentials | undefined> {
    const record = this.#rows.get(agentId);
    return record ? unsealAgentSecret(this.#key, record, this.path) : undefined;
  }

  async putPerplCredentials(agentId: string, credentials: PerplCredentials): Promise<void> {
    this.#rows.put(sealAgentSecret(this.#key, agentId, credentials));
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.#rows.delete(agentId);
  }
}
