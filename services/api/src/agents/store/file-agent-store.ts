// The agent store, on disk (SEN-48).
//
// Same semantics as `InMemoryAgentStore` — duplicate id and duplicate MCP token
// hash both rejected, records copied in and out, `revoked` terminal — and
// the spec beside this file runs both implementations through one table so they
// cannot drift apart. The difference is what a restart costs: the Privy wallet,
// its mandate policy and the ERC-8004 identity all live on at their providers,
// and without these records nothing here remembers which user owns them or what
// the agent's MCP token was. That is a hired agent lost mid-demo.
//
// The persisted shape is whatever `AgentRecord` holds — `state/json-file.ts`
// walks the record generically and tags `Date` and `bigint`, so a field added
// to `AgentRecord` persists with no change here.
//
// Erasable syntax and `.ts` specifiers, like its sibling in `wallet/store`, so
// a script can load it under node's type stripping (CLAUDE.md gotcha 10).

import { JsonRecordFile } from '../../state/json-file.ts';
import { addressKey, type AgentPatch, type AgentRecord, type AgentStore } from './agent-store.ts';

export class FileAgentStore implements AgentStore {
  readonly #file: JsonRecordFile<AgentRecord>;
  readonly #byId = new Map<string, AgentRecord>();
  readonly #idByTokenHash = new Map<string, string>();
  readonly #idByAddress = new Map<string, string>();

  /** Loads the file eagerly, so a boot on an unreadable state file fails at boot. */
  constructor(path: string) {
    this.#file = new JsonRecordFile<AgentRecord>(path);
    for (const record of this.#file.load()) {
      this.#byId.set(record.id, record);
      this.#idByTokenHash.set(record.mcpTokenHash, record.id);
      this.#idByAddress.set(addressKey(record.address), record.id);
    }
  }

  /** The file behind this store. Logged at boot so the operator knows what a restart will read. */
  get path(): string {
    return this.#file.path;
  }

  /** How many agents came back from disk. Logged at boot. */
  get size(): number {
    return this.#byId.size;
  }

  insert(record: AgentRecord): Promise<void> {
    if (this.#byId.has(record.id)) {
      return Promise.reject(new Error(`agent ${record.id} already exists`));
    }
    if (this.#idByTokenHash.has(record.mcpTokenHash)) {
      return Promise.reject(new Error('MCP token hash collision'));
    }
    const stored = structuredClone(record);
    this.#byId.set(record.id, stored);
    this.#idByTokenHash.set(record.mcpTokenHash, record.id);
    this.#idByAddress.set(addressKey(record.address), record.id);
    try {
      this.#persist();
    } catch (error) {
      // An agent that is live in memory and absent from disk would vanish at the
      // next restart with its wallet already funded. Undo and let `hire` fail.
      this.#byId.delete(record.id);
      this.#idByTokenHash.delete(record.mcpTokenHash);
      this.#idByAddress.delete(addressKey(record.address));
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  get(id: string): Promise<AgentRecord | undefined> {
    const record = this.#byId.get(id);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  listByUser(userId: string): Promise<AgentRecord[]> {
    return Promise.resolve(this.#sorted((record) => record.userId === userId));
  }

  listActive(): Promise<AgentRecord[]> {
    return Promise.resolve(this.#sorted((record) => record.status === 'active'));
  }

  findByMcpTokenHash(hash: string): Promise<AgentRecord | undefined> {
    const id = this.#idByTokenHash.get(hash);
    return id === undefined ? Promise.resolve(undefined) : this.get(id);
  }

  findByAddress(address: string): Promise<AgentRecord | undefined> {
    const id = this.#idByAddress.get(addressKey(address));
    return id === undefined ? Promise.resolve(undefined) : this.get(id);
  }

  update(id: string, patch: AgentPatch): Promise<AgentRecord> {
    const existing = this.#byId.get(id);
    if (!existing) return Promise.reject(new Error(`no agent ${id}`));
    const next: AgentRecord = { ...existing, ...structuredClone(patch) };
    this.#byId.set(id, next);
    try {
      this.#persist();
    } catch (error) {
      // A revoke that is not on disk comes back as active after a restart. The
      // caller has to know it did not land.
      this.#byId.set(id, existing);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(structuredClone(next));
  }

  #sorted(keep: (record: AgentRecord) => boolean): AgentRecord[] {
    return [...this.#byId.values()]
      .filter(keep)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((record) => structuredClone(record));
  }

  #persist(): void {
    this.#file.save([...this.#byId.values()]);
  }
}
