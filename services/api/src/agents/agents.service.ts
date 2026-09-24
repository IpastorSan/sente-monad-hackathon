import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  compileMandate,
  compileRevocationRules,
  MandateError,
  parseMandate,
  type AuthorizationPayload,
  type Mandate,
  type PolicyRule,
} from '@sente/mandate';
import { isAddressEqual, type Address } from 'viem';

import type { Principal } from '../auth/principal';
import { GasDripService } from '../gas/gas.service';
import {
  AGENT_WALLETS,
  type AgentWalletProvider,
  type ProvisionedAgentWallet,
} from './agent-wallet.provider';
import { AGENT_MODELS, isAgentModel } from './agents.config';
import {
  AgentRefusedError,
  AgentWalletsUnconfiguredError,
  EnclaveApprovalRefusedError,
  type AgentRefusalReason,
} from './agents.errors';
import { AGENT_NAME_MAX_LENGTH } from './dto/agent.dto';
import { MANDATE_OWNERS, type MandateOwners } from './mandate-owner';
import {
  PreparedApprovals,
  PREPARED_APPROVAL_TTL_MS,
  type PreparedApprovalKind,
} from './prepared-approval';
import { RETURN_ADDRESSES, type ReturnAddresses } from './return-address';
import {
  AGENT_STORE,
  type AgentGasFunding,
  type AgentRecord,
  type AgentStore,
} from './store/agent-store';
import { generateMcpToken, hashMcpToken, MCP_TOKEN_PREFIX } from './store/mcp-token';
import { ERC8004_WRITER, type Erc8004Reputation } from './reputation/erc8004';
import { ALCHEMY_NOTIFY, type AlchemyNotifyAddresses } from '../webhooks/alchemy-notify';

export interface HireAgentInput {
  name: string;
  systemPrompt: string;
  strategy: string;
  model: string;
  /** Untrusted; `parseMandate` validates it. */
  mandate: unknown;
  /**
   * Publish the system prompt so other people can fork it (SEN-28). Absent
   * means `false`: sharing is opt-in, per agent.
   */
  public?: boolean;
}

/**
 * `POST /agents/:id/fork` (SEN-28). There is no `strategy`, `systemPrompt` or
 * `model` here on purpose: the fork takes those from the source agent, and the
 * only thing the caller writes is the mandate that will bound their copy.
 */
export interface ForkAgentInput {
  /** The FORKER's mandate. `parseMandate` validates it. */
  mandate: unknown;
  /** The new agent's name. Absent means `<source name> (fork)`. */
  name?: string;
}

/** What a fork is called when the caller does not name it. */
export const FORK_NAME_SUFFIX = ' (fork)';

/**
 * `Momentum` -> `Momentum (fork)`, clamped to `AGENT_NAME_MAX_LENGTH` so a
 * maximum-length source name still yields a name the API accepts. Exported
 * because the mobile app pre-fills the same string, and a spec pins them
 * together.
 */
export function forkName(sourceName: string): string {
  const room = AGENT_NAME_MAX_LENGTH - FORK_NAME_SUFFIX.length;
  return `${sourceName.trim().slice(0, room)}${FORK_NAME_SUFFIX}`;
}

/**
 * The name a fork is stored under. A caller-supplied name is trimmed and
 * clamped (the DTO already refuses a blank or oversized one over HTTP, and the
 * store's invariants must hold for callers that skip the DTO); a blank or
 * missing one falls back to `forkName(source)`.
 */
function clampAgentName(name: string, sourceName: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return forkName(sourceName);
  return trimmed.slice(0, AGENT_NAME_MAX_LENGTH);
}

export interface HiredAgent {
  agent: AgentRecord;
  /** The MCP bearer token, in plaintext, this once. Only its hash is stored. */
  mcpToken: string;
}

/**
 * What the owner is being asked to approve, in the terms they wrote it in
 * (SEN-44). The phone renders this; it does NOT decide from it.
 *
 * The decision is made against `payload.body`, which the phone checks against
 * the mandate it is holding — see `apps/mobile/src/agents/approval.ts`. A
 * summary is server-composed prose, so trusting it would be trusting the party
 * the signature exists to bind.
 */
export interface MandateChangeSummary {
  kind: 'amend' | 'revoke';
  agentId: string;
  agentName: string;
  policyId: string;
  /**
   * How many rules the policy holds afterwards.
   *
   * On a revoke that is NOT zero since SEN-17: what is left is the way out —
   * `AccountCore.withdraw` and the return transfers — and nothing that lets the
   * agent take risk. Zero means the mandate named no `returnTo` and no venue,
   * so there was no exit to keep.
   */
  ruleCount: number;
}

// The mandate itself is deliberately NOT here. The phone already holds the one
// it is sending — that is the copy it checks the payload against — and echoing
// a server-composed second copy back would only invite a screen to render the
// wrong one.

/** A mandate change waiting for its owner's signature. */
export interface PreparedMandateChange {
  prepareId: string;
  /** The exact bytes to sign. Rebuild it from the intent before you do. */
  payload: AuthorizationPayload;
  expiresAt: Date;
  summary: MandateChangeSummary;
}

/** One phone signature, base64 DER, as Privy's header carries it. */
export interface MandateApproval {
  prepareId: string;
  signature: string;
}

/** What committing a prepared mandate change needs that its request does not carry. */
interface MandateChangeContext {
  /** Stored once the enclave accepts the change. Absent on a revoke. */
  mandate?: Mandate;
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
  /**
   * Mandate changes prepared for a device owner and not yet committed (SEN-44).
   *
   * Process-local state, like `locks`, so it is constructed here rather than
   * injected: there is nothing a caller would want to substitute, and a prepare
   * that outlived the process would be an approval outliving the thing it was
   * given for.
   */
  private readonly prepared = new PreparedApprovals<MandateChangeContext>();

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_WALLETS) private readonly wallets: AgentWalletProvider,
    /**
     * Who owns each new agent's mandate (SEN-43).
     *
     * REQUIRED, unlike the two below, and that is the point: they degrade to a
     * missing feature, this one would degrade to a missing GUARANTEE. An absent
     * binding means `ServerMandateOwners` — every mandate owned by a key this
     * process holds — which is exactly what `AGENT_MANDATE_OWNER` refuses to do
     * silently. So a dropped wire has to be a boot failure, not a default. A
     * caller that really wants the server-owned shape says
     * `new ServerMandateOwners()` out loud.
     */
    @Inject(MANDATE_OWNERS) private readonly owners: MandateOwners,
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
    /**
     * The Alchemy Notify address list (SEN-30). Optional for the same reason
     * again: without it a hired agent's deposits are simply not delivered to
     * `POST /webhooks/alchemy`, and the hire is untouched.
     */
    @Optional()
    @Inject(ALCHEMY_NOTIFY)
    private readonly deposits?: AlchemyNotifyAddresses,
    /**
     * Where each user's agents send funds home to (SEN-17). Optional like the
     * three above, and it degrades the same way: without it a hire compiles no
     * exit rule, which is what every agent hired before SEN-17 has. It is not a
     * guarantee that goes missing — nothing widens, and no money moves anywhere
     * it could not before — but it IS a hire whose funds can only be recovered
     * with an amend, so `hire` says so in the log rather than staying quiet.
     */
    @Optional()
    @Inject(RETURN_ADDRESSES)
    private readonly returnAddresses?: ReturnAddresses,
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
  async hire(principal: Principal, input: HireAgentInput): Promise<HiredAgent> {
    if (!isAgentModel(input.model)) {
      throw new AgentRefusedError(
        'model_not_allowed',
        `model is not offered; choose one of ${AGENT_MODELS.join(', ')}`,
      );
    }
    const mandate = await this.parseFor(principal, input.mandate);
    const rules = compileMandate(mandate);
    const id = randomUUID();
    const { wallet, ownerQuorumId } = await this.provisionWallet(principal, id, rules);

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
      ownerKind: this.owners.mode,
      mcpTokenHash: hashMcpToken(mcpToken),
      status: 'active',
      policyCleared: false,
      // Opt-in, per agent: unset means private, so nothing is shared by accident.
      public: input.public ?? false,
      createdAt: now,
      updatedAt: now,
      gasFunding: { funded: false, reason: 'drip_pending' },
    };
    await this.store.insert(agent);
    this.logger.log(
      `hired agent ${id} for ${principal.userId}: wallet ${wallet.address} ` +
        `policy ${wallet.policyId} (${rules.length} rules, ${this.wallets.name}, ` +
        `owner ${this.describeOwner(ownerQuorumId)}); ${this.describeExit(mandate)}`,
    );
    return this.completeHire(principal, agent, mcpToken);
  }

  /**
   * Forks another agent's strategy under the CALLER's own mandate (SEN-28):
   * the honest way to copy a leaderboard agent is to hire its strategy, never
   * to mirror a stranger's wallet.
   *
   * Copied: `model` and `strategy` — always — and `systemPrompt`, only when the
   * source's owner published it (`source.public`). When it is private the fork
   * gets an EMPTY prompt: we do not summarise, paraphrase or reconstruct
   * someone else's instructions.
   *
   * Not copied, ever: the source's mandate, wallet, address, policy, MCP token,
   * event log and ERC-8004 identity. The forker's mandate is compiled into a
   * NEW policy on a NEW wallet, so a fork can never sign with authority its
   * forker did not grant — and the source's own wallet is untouched by any of
   * this.
   *
   * The source is deliberately NOT ownership-checked: forking a stranger's
   * leaderboard agent is the feature, and the two agents share a strategy and
   * nothing else. A revocation is the one thing that stops it — a revoked
   * agent's strategy is no longer running, so it is refused rather than copied.
   */
  async fork(principal: Principal, sourceId: string, input: ForkAgentInput): Promise<HiredAgent> {
    const source = await this.store.get(sourceId);
    if (!source) {
      throw new AgentRefusedError('agent_not_found', `no agent ${sourceId}`);
    }
    if (source.status === 'revoked') {
      throw new AgentRefusedError(
        'agent_revoked',
        `agent ${sourceId} is revoked, so its strategy is no longer running and cannot be forked`,
      );
    }
    const mandate = await this.parseFor(principal, input.mandate);
    const rules = compileMandate(mandate);
    const id = randomUUID();
    // Provisioned for the FORKER, so the owner quorum is theirs and never the
    // source agent's: a fork is bounded by the person who made it.
    const { wallet, ownerQuorumId } = await this.provisionWallet(principal, id, rules);

    const mcpToken = generateMcpToken();
    const now = new Date();
    const agent: AgentRecord = {
      id,
      userId: principal.userId,
      name:
        input.name !== undefined ? clampAgentName(input.name, source.name) : forkName(source.name),
      systemPrompt: source.public ? source.systemPrompt : '',
      strategy: source.strategy,
      model: source.model,
      mandate,
      walletId: wallet.walletId,
      address: wallet.address,
      policyId: wallet.policyId,
      ownerKind: this.owners.mode,
      mcpTokenHash: hashMcpToken(mcpToken),
      status: 'active',
      policyCleared: false,
      // The fork inherits the strategy, never the source's sharing choice.
      public: false,
      forkedFrom: source.id,
      createdAt: now,
      updatedAt: now,
      gasFunding: { funded: false, reason: 'drip_pending' },
    };
    await this.store.insert(agent);
    this.logger.log(
      `forked agent ${source.id} into ${id} for ${principal.userId}: wallet ${wallet.address} ` +
        `policy ${wallet.policyId} (${rules.length} rules, owner ` +
        `${this.describeOwner(ownerQuorumId)}, prompt ` +
        `${source.public ? 'copied' : 'not copied: the source is private'})`,
    );
    return this.completeHire(principal, agent, mcpToken);
  }

  /**
   * The whole enclave-facing half of a hire: who will own the new mandate, the
   * wallet and policy created under them, and the one failure both share.
   * `hire` and `fork` differ in everything they STORE and in nothing they
   * provision, so this is shared rather than written twice.
   *
   * The display name is the id, never the user-chosen name: it goes to a third
   * party. The owner lookup sits outside the try on purpose — a caller with no
   * registered wallet is a refusal of theirs, not a provider failure.
   */
  private async provisionWallet(
    principal: Principal,
    id: string,
    rules: readonly PolicyRule[],
  ): Promise<{ wallet: ProvisionedAgentWallet; ownerQuorumId: string | undefined }> {
    const ownerQuorumId = await this.ownerQuorum(principal);
    try {
      const wallet = await this.wallets.provision({
        rules,
        displayName: `sente-agent-${id}`,
        ownerQuorumId,
      });
      return { wallet, ownerQuorumId };
    } catch (error) {
      throw this.walletFailure('wallet_provision_failed', error, 'could not provision the wallet');
    }
  }

  /**
   * The quorum that will own this hire's policy and wallet, or `undefined` in
   * `server` mode (the provider then uses its own mandate quorum).
   *
   * Resolved BEFORE anything is provisioned, so a caller with no wallet is
   * refused without leaving a Privy policy behind — the same rule the rest of
   * `hire` follows.
   */
  private async ownerQuorum(principal: Principal): Promise<string | undefined> {
    if (this.owners.mode === 'server') return undefined;
    const quorumId = await this.owners.ownerQuorumFor(principal.userId);
    if (!quorumId) {
      throw new AgentRefusedError(
        'wallet_not_registered',
        'this account has no wallet yet, so there is no device key to own the agent’s ' +
          'mandate; POST /wallet/register from the phone first',
      );
    }
    return quorumId;
  }

  /** For the hire log: which key can change this agent's mandate from now on. */
  private describeOwner(ownerQuorumId: string | undefined): string {
    return ownerQuorumId === undefined
      ? 'server mandate quorum (this server CAN amend)'
      : `device quorum ${ownerQuorumId} (this server cannot amend)`;
  }

  /**
   * The tail every hire shares — a fork is a hire that inherited a strategy, so
   * it gets the same treatment: the on-chain identity first, then the gas. An
   * identity that never gets gas is still worth having, and neither may fail
   * the hire.
   */
  private async completeHire(
    principal: Principal,
    agent: AgentRecord,
    mcpToken: string,
  ): Promise<HiredAgent> {
    const registration = await this.registerIdentity(agent);
    const gasFunding = await this.fundGas(principal, agent);
    // AFTER the drip, deliberately: the drip is our own MON and is normally
    // already mined by now, so it does not show up as a user deposit.
    await this.watchForDeposits(agent);
    return {
      agent: await this.store.update(agent.id, {
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

  /**
   * Asks Alchemy Notify to watch the new agent's wallet, so a deposit to it
   * appends a `deposit` event to its Ledger (SEN-30). Never throws and returns
   * nothing: a webhook that cannot be updated must not fail a hire, and unlike
   * the ERC-8004 id there is nothing worth recording on the agent — the address
   * list is Alchemy's state, not ours, and `docs/alchemy.md` says how to check it.
   */
  private async watchForDeposits(agent: AgentRecord): Promise<void> {
    if (!this.deposits) return;
    try {
      const outcome = await this.deposits.watchAddress(agent.address);
      if (outcome.ok) return;
      this.logger.warn(
        `agent ${agent.id} wallet ${agent.address} not watched for deposits: ` +
          `${outcome.reason} (${outcome.message}) — deposits to it will not reach its Ledger`,
      );
    } catch (error) {
      // watchAddress does not throw; this only keeps a bug there from failing a hire.
      this.logger.error(
        `agent ${agent.id} Alchemy Notify registration threw: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Never throws: an unfunded agent is still hired, and says why. */
  private async fundGas(principal: Principal, agent: AgentRecord): Promise<AgentGasFunding> {
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

  list(principal: Principal): Promise<AgentRecord[]> {
    return this.store.listByUser(principal.userId);
  }

  get(principal: Principal, id: string): Promise<AgentRecord> {
    return this.owned(principal, id);
  }

  /**
   * Recompiles and replaces the wallet's policy, then records the new mandate.
   * If the provider fails, the stored mandate stays the old one — which is
   * still what the enclave enforces.
   *
   * ONLY FOR A `ownerKind: 'server'` AGENT. A device-owned policy is owned by
   * the hirer's phone key (SEN-43), so this server has nothing to sign the PATCH
   * with; the request is refused here with `mandate_approval_required` rather
   * than sent for Privy to answer 401. {@link prepareMandateAmend} is that path.
   */
  amendMandate(principal: Principal, id: string, rawMandate: unknown): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      const agent = await this.owned(principal, id);
      this.requireServerOwned(agent, 'amended');
      if (agent.status === 'revoked') {
        throw new AgentRefusedError(
          'agent_revoked',
          `agent ${id} is revoked; revocation is permanent, so hire a new agent`,
        );
      }
      const mandate = await this.parseFor(principal, rawMandate);
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
   * runner and its MCP token refuse it), then its policy is cleared of
   * everything that lets it take risk.
   *
   * REVOKE LEAVES THE EXIT OPEN (SEN-17). Until then it PATCHed the policy to
   * `[]`, and a wallet whose policy has no rules signs nothing at all — which
   * stops the agent, and also strands whatever it is holding, because a revoked
   * agent cannot be amended either. {@link compileRevocationRules} is the
   * answer: the two recovery rules and nothing else, so the owner can still call
   * `POST /agents/:id/return` afterwards and the agent still cannot approve,
   * deposit, trade or enroll. Nothing in it is new authority — every surviving
   * rule was already in the live policy.
   *
   * The status flips BEFORE the enclave call, on purpose: revocation must not
   * wait on, or be blocked by, the provider. If the policy update fails the
   * agent stays revoked with `policyCleared: false`, and calling revoke again
   * retries it. Idempotent once cleared.
   *
   * ONLY FOR A `ownerKind: 'server'` AGENT, like {@link amendMandate}:
   * re-PATCHing a device-owned policy needs the phone's signature, so this
   * refuses with `mandate_approval_required` and {@link prepareRevoke} carries
   * it.
   */
  revoke(principal: Principal, id: string): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      let agent = await this.owned(principal, id);
      if (agent.status === 'revoked' && agent.policyCleared) return agent;
      this.requireServerOwned(agent, 'revoked');
      // Compiled from the mandate as it stands, before the status flips: the
      // exit it names is the one the live policy already allows.
      const rules = compileRevocationRules(agent.mandate);
      if (agent.status === 'active') {
        const now = new Date();
        agent = await this.store.update(id, { status: 'revoked', revokedAt: now, updatedAt: now });
      }
      try {
        await this.wallets.updatePolicy(agent.policyId, rules);
      } catch (error) {
        throw this.walletFailure(
          'wallet_policy_update_failed',
          error,
          `agent ${id} is revoked and will not run, but its wallet policy was not cleared; ` +
            'revoke it again to retry',
        );
      }
      this.logger.log(
        `revoked agent ${id}: policy ${agent.policyId} now ${rules.length} rule(s), ` +
          `${this.describeExit(agent.mandate)}`,
      );
      return this.store.update(id, { policyCleared: true, updatedAt: new Date() });
    });
  }

  /** For the revoke and hire logs: whether this mandate leaves a way out, and to where. */
  private describeExit(mandate: Mandate): string {
    return mandate.returnTo
      ? `funds can still be returned to ${mandate.returnTo}`
      : 'NO return rule: this mandate names no returnTo, so its funds can only be recovered with ' +
          'the owner key';
  }

  // -------------------------------------------------------------------------
  // SEN-44: changing a mandate whose owner is a phone
  //
  // `prepare` composes the enclave request and hands back the payload to sign;
  // `commit` sends THAT request with the signature attached. Nothing between
  // them touches Privy, and nothing after them recomposes the request — the
  // signature covers its bytes, so composing it twice is how an approved change
  // and a sent change come to differ.
  //
  // Neither half can make the server the owner of anything. The server can
  // refuse to send a signed change, and can propose one the owner then refuses
  // to sign; what it cannot do is change a mandate, which is the property.
  // -------------------------------------------------------------------------

  /**
   * The PATCH that would install `rawMandate` on a device-owned agent, held for
   * its owner to approve. Mutates nothing: a prepare that failed to be committed
   * must leave the agent exactly as it was.
   */
  async prepareMandateAmend(
    principal: Principal,
    id: string,
    rawMandate: unknown,
  ): Promise<PreparedMandateChange> {
    const agent = await this.owned(principal, id);
    this.requireDeviceOwned(agent, 'amended');
    if (agent.status === 'revoked') {
      throw new AgentRefusedError(
        'agent_revoked',
        `agent ${id} is revoked; revocation is permanent, so hire a new agent`,
      );
    }
    const mandate = await this.parseFor(principal, rawMandate);
    // The SAME compiler the one-step path and the hire use: what the owner
    // approves has to be what the enclave would have been given anyway.
    const rules = compileMandate(mandate);
    return this.prepare(principal, agent, 'mandate_amend', rules, { mandate });
  }

  /**
   * The same, for the PATCH that revokes: {@link compileRevocationRules}, so the
   * wallet is left able to send its funds home and nothing else.
   *
   * The phone recompiles those rules from the mandate it is holding and refuses
   * to sign anything wider (`apps/mobile/src/agents/approval.ts`), which is why
   * the rules are compiled from the STORED mandate here rather than composed
   * freely: the two have to agree, and the stored mandate is the copy both sides
   * can read.
   */
  async prepareRevoke(principal: Principal, id: string): Promise<PreparedMandateChange> {
    const agent = await this.owned(principal, id);
    this.requireDeviceOwned(agent, 'revoked');
    if (agent.status === 'revoked' && agent.policyCleared) {
      throw new AgentRefusedError(
        'agent_revoked',
        `agent ${id} is already revoked and its policy is cleared; there is nothing to sign`,
      );
    }
    return this.prepare(
      principal,
      agent,
      'mandate_revoke',
      compileRevocationRules(agent.mandate),
      {},
    );
  }

  /**
   * Sends a prepared amend with the owner's signature, and records the new
   * mandate once the enclave has taken it.
   *
   * The prepare is spent whatever happens next, including a failure at the
   * enclave: a signature that stays committable is a signature waiting to be
   * replayed, and preparing again costs one round trip and one prompt. If the
   * enclave refused, the stored mandate is untouched — which is still exactly
   * what the policy enforces.
   */
  commitMandateAmend(
    principal: Principal,
    id: string,
    approval: MandateApproval,
  ): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      const agent = await this.owned(principal, id);
      const prepared = this.takePrepared(principal, agent, 'mandate_amend', approval.prepareId);
      if (agent.status === 'revoked') {
        throw new AgentRefusedError(
          'agent_revoked',
          `agent ${id} is revoked; revocation is permanent, so hire a new agent`,
        );
      }
      try {
        await this.wallets.commitPrepared(prepared.request, { signature: approval.signature });
      } catch (error) {
        throw this.walletFailure(
          'wallet_policy_update_failed',
          error,
          `could not update the policy of agent ${id}; its previous mandate still applies`,
        );
      }
      const mandate = prepared.context.mandate;
      if (!mandate) throw new Error(`prepared amend ${approval.prepareId} carried no mandate`);
      this.logger.log(
        `amended agent ${id} with an owner signature: policy ${agent.policyId} replaced`,
      );
      return this.store.update(id, { mandate, updatedAt: new Date() });
    });
  }

  /**
   * Sends a prepared revoke with the owner's signature.
   *
   * Status first, then the enclave, exactly as the server-owned path does: a
   * revocation must not wait on the provider. Unlike that path, the prepare is
   * checked BEFORE the status flips — a malformed commit is a bad request, not
   * a reason to stop someone's agent.
   */
  commitRevoke(principal: Principal, id: string, approval: MandateApproval): Promise<AgentRecord> {
    return this.withAgentLock(id, async () => {
      let agent = await this.owned(principal, id);
      const prepared = this.takePrepared(principal, agent, 'mandate_revoke', approval.prepareId);
      if (agent.status === 'active') {
        const now = new Date();
        agent = await this.store.update(id, { status: 'revoked', revokedAt: now, updatedAt: now });
      }
      try {
        await this.wallets.commitPrepared(prepared.request, { signature: approval.signature });
      } catch (error) {
        throw this.walletFailure(
          'wallet_policy_update_failed',
          error,
          `agent ${id} is revoked and will not run, but its wallet policy was not emptied; ` +
            'prepare and sign a revoke again to retry',
        );
      }
      this.logger.log(
        `revoked agent ${id} with an owner signature: policy ${agent.policyId} emptied`,
      );
      return this.store.update(id, { policyCleared: true, updatedAt: new Date() });
    });
  }

  /** Composes the request, stores it, and returns what the phone needs. */
  private async prepare(
    principal: Principal,
    agent: AgentRecord,
    kind: PreparedApprovalKind,
    rules: readonly PolicyRule[],
    context: MandateChangeContext,
  ): Promise<PreparedMandateChange> {
    let prepared;
    try {
      prepared = await this.wallets.preparePolicyUpdate(agent.policyId, rules);
    } catch (error) {
      throw this.walletFailure(
        'wallet_policy_update_failed',
        error,
        `could not prepare a policy change for agent ${agent.id}; nothing was changed`,
      );
    }
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + PREPARED_APPROVAL_TTL_MS);
    const id = randomUUID();
    this.prepared.put({
      id,
      kind,
      userId: principal.userId,
      // The subject of a mandate change is the agent it bounds.
      subject: agent.id,
      request: prepared.request,
      payload: prepared.payload,
      context,
      createdAt,
      expiresAt,
    });
    return {
      prepareId: id,
      payload: prepared.payload,
      expiresAt,
      summary: {
        kind: kind === 'mandate_amend' ? 'amend' : 'revoke',
        agentId: agent.id,
        agentName: agent.name,
        policyId: agent.policyId,
        ruleCount: rules.length,
      },
    };
  }

  /**
   * The prepared change this commit names, spent.
   *
   * Every mismatch — unknown id, expired, already committed, another user's,
   * another agent's, prepared for the other operation — is the same
   * `mandate_prepare_not_found`, because they are all "there is no such
   * pending change", and telling them apart would describe other people's.
   */
  private takePrepared(
    principal: Principal,
    agent: AgentRecord,
    kind: PreparedApprovalKind,
    prepareId: string,
  ) {
    this.requireDeviceOwned(agent, kind === 'mandate_amend' ? 'amended' : 'revoked');
    const prepared = this.prepared.take(prepareId, principal.userId, new Date());
    if (!prepared || prepared.kind !== kind || prepared.subject !== agent.id) {
      throw new AgentRefusedError(
        'mandate_prepare_not_found',
        `no pending change ${prepareId} for agent ${agent.id}; prepared changes are single-use ` +
          `and expire after ${PREPARED_APPROVAL_TTL_MS / 60000} minutes, so prepare it again`,
      );
    }
    return prepared;
  }

  /** The one-step routes: refused when only a phone can approve the change. */
  private requireServerOwned(agent: AgentRecord, verb: string): void {
    if (agent.ownerKind !== 'device') return;
    throw new AgentRefusedError(
      'mandate_approval_required',
      `agent ${agent.id}'s mandate is owned by the device key that hired it, so this server ` +
        `cannot have it ${verb} on its own; prepare the change and sign it on that device`,
    );
  }

  /** The prepare/commit routes: refused when the server owns the policy itself. */
  private requireDeviceOwned(agent: AgentRecord, verb: string): void {
    if (agent.ownerKind === 'device') return;
    throw new AgentRefusedError(
      'mandate_approval_not_required',
      `agent ${agent.id}'s mandate is owned by this server, so there is no device signature to ` +
        `collect; have it ${verb} with the one-step route`,
    );
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

  private async owned(principal: Principal, id: string): Promise<AgentRecord> {
    const agent = await this.store.get(id);
    if (!agent || agent.userId !== principal.userId) {
      throw new AgentRefusedError('agent_not_found', `no agent ${id}`);
    }
    return agent;
  }

  /**
   * `parse`, and then the ONE field a client does not get to write: `returnTo`,
   * the address the agent's wallet may send ERC-20s to (SEN-15).
   *
   * Resolved from the caller's registered user wallet (SEN-40) on every hire,
   * fork and amend, so "how do I get my money out" has an answer from the
   * moment an agent exists. A client value is only ever COMPARED with it:
   *
   * - equal (or absent) — fine, the resolved address is what compiles;
   * - different — `return_address_mismatch`. A client that could name the exit
   *   could name its own, and this is a rule the enclave will then enforce
   *   against the owner rather than for them;
   * - no registered wallet at all — a client value is `return_address_unavailable`
   *   (there is nothing to compare it with), and no client value compiles no
   *   exit rule, exactly as before SEN-17.
   *
   * The comparison is `isAddressEqual`, not string equality: the client's copy
   * came back through JSON and a caller may well have lowercased it.
   */
  private async parseFor(principal: Principal, raw: unknown): Promise<Mandate> {
    const mandate = this.parse(raw);
    const resolved = await this.returnAddressFor(principal);
    if (!resolved) {
      if (!mandate.returnTo) return mandate;
      throw new AgentRefusedError(
        'return_address_unavailable',
        'returnTo is set by this server from your own wallet, and this account has no wallet ' +
          'yet, so there is nothing it could be; POST /wallet/register from the phone first, or ' +
          'leave returnTo out',
      );
    }
    if (mandate.returnTo && !isAddressEqual(mandate.returnTo, resolved)) {
      throw new AgentRefusedError(
        'return_address_mismatch',
        `returnTo must be your own wallet, ${resolved}, and this mandate names ` +
          `${mandate.returnTo}; the address an agent may send funds to is resolved by this ` +
          'server, never taken from the request',
      );
    }
    return { ...mandate, returnTo: resolved };
  }

  private returnAddressFor(principal: Principal): Promise<Address | undefined> {
    return this.returnAddresses?.addressFor(principal.userId) ?? Promise.resolve(undefined);
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
    // The owner's own signature was refused: that is an answer about the
    // request, not a provider outage, and the caller must see it as itself.
    if (error instanceof EnclaveApprovalRefusedError) return error;
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
