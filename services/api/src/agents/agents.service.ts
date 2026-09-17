import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { compileMandate, MandateError, parseMandate, type Mandate } from '@sente/mandate';

import type { GasDripPrincipal } from '../gas/auth/gas-drip-auth';
import { GasDripService } from '../gas/gas.service';
import { AGENT_WALLETS, type AgentWalletProvider } from './agent-wallet.provider';
import { AGENT_MODELS, isAgentModel } from './agents.config';
import {
  AgentRefusedError,
  AgentWalletsUnconfiguredError,
  type AgentRefusalReason,
} from './agents.errors';
import {
  AGENT_STORE,
  type AgentGasFunding,
  type AgentRecord,
  type AgentStore,
} from './store/agent-store';
import { generateMcpToken, hashMcpToken, MCP_TOKEN_PREFIX } from './store/mcp-token';
import { ERC8004_WRITER, type Erc8004Reputation } from './reputation/erc8004';

export interface HireAgentInput {
  name: string;
  systemPrompt: string;
  strategy: string;
  model: string;
  /** Untrusted; `parseMandate` validates it. */
  mandate: unknown;
}

export interface HiredAgent {
  agent: AgentRecord;
  /** The MCP bearer token, in plaintext, this once. Only its hash is stored. */
  mcpToken: string;
}

/** The slice of `GasDripService` hiring needs. */
export type AgentGasFunder = Pick<GasDripService, 'dripToAgent'>;

/**
 * The agent lifecycle. Every method takes the authenticated principal and
 * scopes to it: another user's agent is `agent_not_found`, never a 403, so a
 * guessed id reveals nothing.
 *
 * The mandate reaches the enclave in exactly two places — `provision` at hire
 * and `updatePolicy` on amend/revoke — and both carry `compileMandate`'s rules
 * verbatim. The provider signs policy updates with the mandate-owner key, not
 * the agent's trading key (SEN-3).
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);
  /** Serialises amend and revoke per agent; see `withAgentLock`. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_WALLETS) private readonly wallets: AgentWalletProvider,
    /**
     * The MON gas drip (SEN-14). Optional so a caller without the gas module
     * still hires; its agents come back `gasFunded: false`,
     * `gas_drip_unavailable`. AgentsModule imports GasModule, so the app has it.
     */
    @Optional() @Inject(GasDripService) private readonly gas?: AgentGasFunder,
    /**
     * The ERC-8004 registration (SEN-27). Optional for the same reason: an
     * unconfigured registry leaves `erc8004AgentId` unset rather than failing a
     * hire. AgentsModule provides it, wrapping the event log so verdicts write
     * reputation too.
     */
    @Optional()
    @Inject(ERC8004_WRITER)
    private readonly reputation?: Erc8004Reputation,
  ) {}

  /**
   * parseMandate -> compileMandate -> provision (wallet + policy together) ->
   * store -> ERC-8004 identity -> gas drip. Everything that can be refused
   * locally is refused before the provider is called, so a bad request never
   * creates a Privy object.
   *
   * The registry write and the drip run after the agent is stored, so a slow or
   * failed one can never lose track of a provisioned wallet, and their outcomes
   * are recorded on the agent rather than failing the hire.
   */
  async hire(principal: GasDripPrincipal, input: HireAgentInput): Promise<HiredAgent> {
    if (!isAgentModel(input.model)) {
      throw new AgentRefusedError(
        'model_not_allowed',
        `model is not offered; choose one of ${AGENT_MODELS.join(', ')}`,
      );
    }
    const mandate = this.parse(input.mandate);
    const rules = compileMandate(mandate);

    const id = randomUUID();
    let wallet;
    try {
      // The id, not the user-chosen name: the display name goes to a third party.
      wallet = await this.wallets.provision({ rules, displayName: `sente-agent-${id}` });
    } catch (error) {
      throw this.walletFailure('wallet_provision_failed', error, 'could not provision the wallet');
    }

    const mcpToken = generateMcpToken();
    const now = new Date();
    const agent: AgentRecord = {
      id,
      userId: principal.userId,
      name: input.name,
      systemPrompt: input.systemPrompt,
      strategy: input.strategy,
      model: input.model,
      mandate,
      walletId: wallet.walletId,
      address: wallet.address,
      policyId: wallet.policyId,
      mcpTokenHash: hashMcpToken(mcpToken),
      status: 'active',
      policyCleared: false,
      createdAt: now,
      updatedAt: now,
      gasFunding: { funded: false, reason: 'drip_pending' },
    };
    await this.store.insert(agent);
    this.logger.log(
      `hired agent ${id} for ${principal.userId}: wallet ${wallet.address} ` +
        `policy ${wallet.policyId} (${rules.length} rules, ${this.wallets.name})`,
    );
    // The on-chain identity first, then the gas: an identity that never gets gas
    // is still worth having, and neither may fail the hire.
    const registration = await this.registerIdentity(agent);
    const gasFunding = await this.fundGas(principal, agent);
    return {
      agent: await this.store.update(id, {
        gasFunding,
        ...(registration.agentId !== undefined ? { erc8004AgentId: registration.agentId } : {}),
      }),
      mcpToken,
    };
  }

  /**
   * Registers the agent in the ERC-8004 Identity Registry (SEN-27). Never
   * throws, exactly like `fundGas`: an agent whose registration failed is
   * hired, runs, and simply has no public track record yet. The registrar key
   * signs, not the agent's wallet, so the mandate's policy is untouched.
   */
  private async registerIdentity(agent: AgentRecord): Promise<{ agentId?: string }> {
    if (!this.reputation) return {};
    try {
      const outcome = await this.reputation.registerOnHire(agent);
      if (outcome.ok) return { agentId: outcome.agentId };
      this.logger.warn(
        `agent ${agent.id} not registered with ERC-8004: ${outcome.reason} (${outcome.message})`,
      );
      return {};
    } catch (error) {
      // registerOnHire does not throw; this only keeps a bug there from failing a hire.
      this.logger.error(
        `agent ${agent.id} ERC-8004 registration threw: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  /** Never throws: an unfunded agent is still hired, and says why. */
  private async fundGas(principal: GasDripPrincipal, agent: AgentRecord): Promise<AgentGasFunding> {
    if (!this.gas) return { funded: false, reason: 'gas_drip_unavailable' };
    try {
      const outcome = await this.gas.dripToAgent({
        userId: principal.userId,
        agentId: agent.id,
        address: agent.address,
      });
      if (outcome.funded) {
        return {
          funded: true,
          txHash: outcome.receipt.txHash,
          amountWei: outcome.receipt.amountWei,
        };
      }
      this.logger.warn(`agent ${agent.id} not gas-funded: ${outcome.reason} (${outcome.message})`);
      return {
        funded: false,
        reason: outcome.reason,
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      };
    } catch (error) {
      // dripToAgent does not throw; this only keeps a bug there from failing a hire.
      this.logger.error(
        `agent ${agent.id} gas drip threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { funded: false, reason: 'drip_failed' };
    }
  }

  list(principal: GasDripPrincipal): Promise<AgentRecord[]> {
    return this.store.listByUser(principal.userId);
  }

  get(principal: GasDripPrincipal, id: string): Promise<AgentRecord> {
    return this.owned(principal, id);
  }

  /**
   * Recompiles and replaces the wallet's policy, then records the new mandate.
   * If the provider fails, the stored mandate stays the old one — which is
   * still what the enclave enforces.
   */
  amendMandate(principal: GasDripPrincipal, id: string, rawMandate: unknown): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      const agent = await this.owned(principal, id);
      if (agent.status === 'revoked') {
        throw new AgentRefusedError(
          'agent_revoked',
          `agent ${id} is revoked; revocation is permanent, so hire a new agent`,
        );
      }
      const mandate = this.parse(rawMandate);
      const rules = compileMandate(mandate);
      try {
        await this.wallets.updatePolicy(agent.policyId, rules);
      } catch (error) {
        throw this.walletFailure(
          'wallet_policy_update_failed',
          error,
          `could not update the policy of agent ${id}; its previous mandate still applies`,
        );
      }
      this.logger.log(`amended agent ${id}: policy ${agent.policyId} now ${rules.length} rules`);
      return this.store.update(id, { mandate, updatedAt: new Date() });
    });
  }

  /**
   * Permanently revokes the agent: it stops at once (status `revoked`, so the
   * runner and its MCP token refuse it), then its policy is emptied. Privy is
   * deny-by-default, so `[]` means the wallet can sign nothing.
   *
   * The status flips BEFORE the enclave call, on purpose: revocation must not
   * wait on, or be blocked by, the provider. If the policy update fails the
   * agent stays revoked with `policyCleared: false`, and calling revoke again
   * retries it. Idempotent once cleared.
   */
  revoke(principal: GasDripPrincipal, id: string): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      let agent = await this.owned(principal, id);
      if (agent.status === 'revoked' && agent.policyCleared) return agent;
      if (agent.status === 'active') {
        const now = new Date();
        agent = await this.store.update(id, { status: 'revoked', revokedAt: now, updatedAt: now });
      }
      try {
        await this.wallets.updatePolicy(agent.policyId, []);
      } catch (error) {
        throw this.walletFailure(
          'wallet_policy_update_failed',
          error,
          `agent ${id} is revoked and will not run, but its wallet policy was not emptied; ` +
            'revoke it again to retry',
        );
      }
      this.logger.log(`revoked agent ${id}: policy ${agent.policyId} emptied`);
      return this.store.update(id, { policyCleared: true, updatedAt: new Date() });
    });
  }

  /**
   * The ACTIVE agent an MCP bearer token belongs to, or `undefined` — for a
   * wrong token and a revoked agent alike, so both are a 401 (SEN-7). The
   * token is hashed before the lookup and never logged.
   */
  async findByMcpToken(token: string): Promise<AgentRecord | undefined> {
    if (!token.startsWith(MCP_TOKEN_PREFIX)) return undefined;
    const agent = await this.store.findByMcpTokenHash(hashMcpToken(token));
    return agent?.status === 'active' ? agent : undefined;
  }

  private async owned(principal: GasDripPrincipal, id: string): Promise<AgentRecord> {
    const agent = await this.store.get(id);
    if (!agent || agent.userId !== principal.userId) {
      throw new AgentRefusedError('agent_not_found', `no agent ${id}`);
    }
    return agent;
  }

  /** `parseMandate`, plus: a mandate that has already expired would hire an agent that can do nothing. */
  private parse(raw: unknown): Mandate {
    let mandate: Mandate;
    try {
      mandate = parseMandate(raw);
    } catch (error) {
      if (error instanceof MandateError)
        throw new AgentRefusedError('mandate_invalid', error.message);
      throw error;
    }
    if (mandate.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new AgentRefusedError('mandate_invalid', 'invalid mandate: expiresAt is in the past');
    }
    return mandate;
  }

  /**
   * A provider failure as a refusal. "Not configured" passes through with its
   * own reason (503); anything else is logged here and summarised to the
   * caller. Provider errors carry no secrets (SEN-3), only ids and Privy's text.
   */
  private walletFailure(reason: AgentRefusalReason, error: unknown, message: string): Error {
    if (error instanceof AgentWalletsUnconfiguredError) return error;
    this.logger.error(`${reason}: ${error instanceof Error ? error.message : String(error)}`);
    return new AgentRefusedError(reason, message);
  }

  /**
   * Runs `run` after every earlier locked call for the same agent has settled.
   *
   * Without it, an amend already past its status check could land its
   * `updatePolicy(rules)` AFTER a concurrent revoke's `updatePolicy([])`,
   * re-arming a revoked wallet. In-process only, which matches the in-memory
   * store; a shared store needs a shared lock.
   */
  private async withAgentLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    }
  }
}
