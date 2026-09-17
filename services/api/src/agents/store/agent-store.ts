import type { Mandate } from '@sente/mandate';
import type { Address, Hash } from 'viem';

import type { AgentDripRefusalReason } from '../../gas/gas.errors';
import type { AgentModel } from '../agents.config';

/** DI token for agent persistence. */
export const AGENT_STORE = Symbol('AGENT_STORE');

export const AGENT_STATUSES = ['active', 'revoked'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Why an agent has no gas drip: the gas module's reasons, plus
 * `gas_drip_unavailable` (no drip wired in) and `drip_pending` (hired, drip
 * still in progress).
 */
export type AgentGasFundingReason =
  AgentDripRefusalReason | 'gas_drip_unavailable' | 'drip_pending';

/** The MON gas drip at hire (SEN-14). A drip that fails never fails the hire. */
export interface AgentGasFunding {
  readonly funded: boolean;
  /** Only when not funded. */
  readonly reason?: AgentGasFundingReason;
  /** The drip transaction: when funded, or when broadcast but unconfirmed. */
  readonly txHash?: Hash;
  readonly amountWei?: bigint;
}

/**
 * One hired agent. The mandate is stored PARSED (bigint atoms, checksummed
 * addresses); the wire form is `dto/agent.dto.ts#toMandateDto`.
 */
export interface AgentRecord {
  /** UUID v4. */
  readonly id: string;
  /** The owner. Every read and write is scoped to it. */
  readonly userId: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly strategy: string;
  /** An OpenRouter model id from `AGENT_MODELS`. */
  readonly model: AgentModel;
  /** The mandate the wallet's policy was last compiled from. */
  readonly mandate: Mandate;
  /** The provider's (Privy's) wallet id. */
  readonly walletId: string;
  /**
   * The agent's own EOA, EIP-55. The user funds its collateral; the server
   * only drips MON for gas, once, at hire (`gasFunding`).
   */
  readonly address: Address;
  /** The policy that bounds the wallet. Emptied (`[]`) on revoke. */
  readonly policyId: string;
  /**
   * sha256 (hex) of the agent's MCP bearer token. The token itself is handed
   * out once, by `hire`, and never stored — see `mcp-token.ts`.
   */
  readonly mcpTokenHash: string;
  /** `revoked` is terminal: nothing moves an agent back to `active`. */
  readonly status: AgentStatus;
  /**
   * Whether the wallet's policy has been replaced with `[]`. Only meaningful
   * once revoked: the agent is marked revoked FIRST, so it stops at once even
   * when the enclave update fails, and a repeated revoke retries until this is
   * true.
   */
  readonly policyCleared: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt?: Date;
  /**
   * Whether the owner published this agent's system prompt (SEN-28). Default
   * `false`: nothing is shared until its owner says so, and a fork copies the
   * system prompt ONLY when this is true. The strategy and the model are
   * copyable either way — they are what a fork is for.
   *
   * The forked agent always starts `false`, whoever it was forked from.
   */
  readonly public: boolean;
  /**
   * The agent this one's strategy was forked from (SEN-28), if any. Lineage
   * only: the source's mandate, wallet, policy, MCP token, event log and
   * ERC-8004 identity are NOT inherited, so this is a fact about where the
   * strategy came from and nothing more.
   */
  readonly forkedFrom?: string;
  /**
   * The gas drip's outcome. Optional so records built elsewhere (specs, older
   * code) stay valid; absent reads as not funded.
   */
  readonly gasFunding?: AgentGasFunding;
  /**
   * The agent's ERC-8004 `agentId` on Monad testnet, as a decimal string — a
   * uint256 does not survive JSON. Absent when the agent has no on-chain
   * identity: no registrar key is configured, or the registration failed, which
   * never fails a hire (SEN-27, the same shape as `gasFunding`).
   */
  readonly erc8004AgentId?: string;
}

/** The only fields that change after hire. */
export type AgentPatch = Partial<
  Pick<
    AgentRecord,
    | 'mandate'
    | 'status'
    | 'policyCleared'
    | 'updatedAt'
    | 'revokedAt'
    | 'gasFunding'
    | 'erc8004AgentId'
  >
>;

export interface AgentStore {
  /** Rejects a duplicate id or token hash. */
  insert(record: AgentRecord): Promise<void>;
  get(id: string): Promise<AgentRecord | undefined>;
  /** The user's agents, oldest first. */
  listByUser(userId: string): Promise<AgentRecord[]>;
  /** Every active agent, oldest first: what the run scheduler ticks (SEN-8). */
  listActive(): Promise<AgentRecord[]>;
  /**
   * The agent whose MCP token hashes to `hash`, WHATEVER its status — the
   * caller decides what a revoked agent's token means. Callers holding a raw
   * token should use `AgentsService.findByMcpToken`, which hashes it and
   * answers only for active agents.
   */
  findByMcpTokenHash(hash: string): Promise<AgentRecord | undefined>;
  /** Rejects an unknown id. Returns the updated record. */
  update(id: string, patch: AgentPatch): Promise<AgentRecord>;
}

/**
 * PERSISTENCE: in memory, because this repo has no database yet — the same
 * call `wallet/store` and `gas/ledger` made. Bind `AGENT_STORE` to a real
 * store and nothing else in `agents/` changes.
 *
 * Losing it on restart is NOT harmless here, unlike the wallet registry: the
 * Privy wallets and policies live on, but the server forgets which user owns
 * which. That is acceptable for testnet only.
 *
 * Records are copied in and out, so a caller mutating what it got back cannot
 * reach the stored state.
 */
export class InMemoryAgentStore implements AgentStore {
  private readonly byId = new Map<string, AgentRecord>();
  private readonly idByTokenHash = new Map<string, string>();

  insert(record: AgentRecord): Promise<void> {
    if (this.byId.has(record.id)) {
      return Promise.reject(new Error(`agent ${record.id} already exists`));
    }
    if (this.idByTokenHash.has(record.mcpTokenHash)) {
      return Promise.reject(new Error('MCP token hash collision'));
    }
    this.byId.set(record.id, structuredClone(record));
    this.idByTokenHash.set(record.mcpTokenHash, record.id);
    return Promise.resolve();
  }

  get(id: string): Promise<AgentRecord | undefined> {
    const record = this.byId.get(id);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  listByUser(userId: string): Promise<AgentRecord[]> {
    const records = [...this.byId.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((record) => structuredClone(record));
    return Promise.resolve(records);
  }

  listActive(): Promise<AgentRecord[]> {
    const records = [...this.byId.values()]
      .filter((record) => record.status === 'active')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((record) => structuredClone(record));
    return Promise.resolve(records);
  }

  findByMcpTokenHash(hash: string): Promise<AgentRecord | undefined> {
    const id = this.idByTokenHash.get(hash);
    return id === undefined ? Promise.resolve(undefined) : this.get(id);
  }

  update(id: string, patch: AgentPatch): Promise<AgentRecord> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.reject(new Error(`no agent ${id}`));
    const next: AgentRecord = { ...existing, ...structuredClone(patch) };
    this.byId.set(id, next);
    return Promise.resolve(structuredClone(next));
  }
}
