import type { PolicyRule } from '@sente/mandate';
import { getAddress, type Hex, type TypedDataDefinition } from 'viem';

import type {
  AgentWalletProvider,
  EnclaveApproval,
  EnclaveRequest,
  PreparedEnclaveRequest,
  ProvisionAgentWalletInput,
  ProvisionedAgentWallet,
} from '../agent-wallet.provider.ts';
import {
  EnclaveApprovalRefusedError,
  EnclaveRefusedError,
  type EnclaveSignMethod,
} from '../agents.errors.ts';
import {
  createAgentWallet,
  signTransaction,
  signTypedData,
  type PrivyTransactionRequest,
} from './agent-wallet.ts';
import type { AuthorizationKey } from './authorization-key.ts';
import { createKeyQuorum } from './key-quorum.ts';
import { createPolicy, policyPath, policyRulesBody, updatePolicyRules } from './policies.ts';
import { PrivyError, type PrivyClient } from './privy.client.ts';

export interface PrivyAgentWalletProviderOptions {
  client: PrivyClient;
  /** The trading SIGNER on every wallet (SEN-31); approves every signature. Never owns a wallet. */
  agentKey: AuthorizationKey;
  /** Owns every wallet AND every policy; approves policy changes and wallet PATCHes. Never signs a trade. */
  mandateOwnerKey: AuthorizationKey;
  agentQuorumId?: string;
  mandateQuorumId?: string;
  /** Told the ids of quorums this provider had to create, so they can be pinned in `.env`. */
  onQuorumsCreated?: (ids: { agentQuorumId: string; mandateQuorumId: string }) => void;
}

interface Quorums {
  agentQuorumId: string;
  mandateQuorumId: string;
}

/**
 * {@link AgentWalletProvider} over Privy server wallets.
 *
 * No Nest decorator and no parameter properties: the module builds it with a
 * factory (as `wallet/` builds `PimlicoBundler`), and scripts/privy-probe.ts
 * loads this exact file under node's type stripping.
 */
export class PrivyAgentWalletProvider implements AgentWalletProvider {
  readonly name = 'privy';
  readonly #client: PrivyClient;
  readonly #agentKey: AuthorizationKey;
  readonly #mandateOwnerKey: AuthorizationKey;
  readonly #options: PrivyAgentWalletProviderOptions;
  #quorums: Promise<Quorums> | undefined;
  /**
   * One signing request in flight per wallet. Privy updates an aggregation
   * only AFTER it signs, so concurrent signs can all pass a rolling cap.
   * Serialising removes that race but NOT the whole gap: the live probe saw a
   * sign ~0.1 s after the previous one pass a cap it pushed over, while one
   * 5 s later was refused. So the rolling cap can still overshoot by about one
   * per-transaction maximum per few seconds; a caller that needs it exact must
   * also pace its signs (docs/privy-policy-enforcement.md).
   */
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(options: PrivyAgentWalletProviderOptions) {
    this.#client = options.client;
    this.#agentKey = options.agentKey;
    this.#mandateOwnerKey = options.mandateOwnerKey;
    this.#options = options;
  }

  async provision(input: ProvisionAgentWalletInput): Promise<ProvisionedAgentWallet> {
    const { agentQuorumId, mandateQuorumId } = await this.quorums();
    // The caller's quorum when it named one — the hirer's device key (SEN-43);
    // otherwise this server's mandate quorum, the pre-Phase-3 shape.
    const ownerQuorumId = input.ownerQuorumId ?? mandateQuorumId;
    const policy = await createPolicy(this.#client, {
      name: `Sente mandate: ${input.displayName}`,
      rules: input.rules,
      ownerQuorumId,
    });
    // Owner = that same quorum; the agent quorum is only an additional SIGNER
    // (SEN-31). The trading key can sign within the mandate but cannot PATCH
    // the wallet to detach or widen it. Policy and wallet share one owner on
    // purpose: an owner that can rewrite the wallet but not its policy could
    // still detach the policy, which is the SEN-31 hole all over again.
    const wallet = await createAgentWallet(this.#client, {
      ownerQuorumId,
      signerQuorumId: agentQuorumId,
      policyId: policy.id,
      displayName: input.displayName,
    });
    return { walletId: wallet.id, address: getAddress(wallet.address), policyId: policy.id };
  }

  signTransaction(walletId: string, tx: PrivyTransactionRequest): Promise<Hex> {
    return this.#serial(walletId, 'eth_signTransaction', () =>
      signTransaction(this.#client, { walletId, transaction: tx, approvals: [this.#agentKey] }),
    );
  }

  signTypedData(walletId: string, typed: TypedDataDefinition): Promise<Hex> {
    return this.#serial(walletId, 'eth_signTypedData_v4', () =>
      signTypedData(this.#client, { walletId, typedData: typed, approvals: [this.#agentKey] }),
    );
  }

  /**
   * Only works on a policy this server's mandate quorum owns. On a policy
   * provisioned under a user's device quorum (SEN-43) Privy answers 401, and it
   * should: the whole point is that this process cannot rewrite that mandate.
   * SEN-44 is the path that asks the phone to sign the PATCH instead.
   */
  async updatePolicy(policyId: string, rules: readonly PolicyRule[]): Promise<void> {
    await updatePolicyRules(this.#client, {
      policyId,
      rules,
      approvals: [this.#mandateOwnerKey],
    });
  }

  /**
   * The PATCH a device-owned policy needs, and the payload its owner signs
   * (SEN-44). No key of this server's is involved, and none would help: the
   * quorum that owns the policy holds only the phone's key.
   */
  preparePolicyUpdate(
    policyId: string,
    rules: readonly PolicyRule[],
  ): Promise<PreparedEnclaveRequest> {
    const path = policyPath(policyId);
    const body = policyRulesBody({ rules });
    return Promise.resolve({
      request: { method: 'PATCH', path, body, subject: policyId },
      payload: this.#client.authorizationPayload('PATCH', path, body),
    });
  }

  async commitPrepared(request: EnclaveRequest, approval: EnclaveApproval): Promise<void> {
    try {
      await this.#client.request(request.method, request.path, request.body, {
        signatures: [approval.signature],
      });
    } catch (error) {
      // A signature over other bytes and a key outside the owner quorum look
      // the same from here, and Privy answers both 401. Either way the owner
      // did not approve THIS request, which is what the caller must be told.
      if (error instanceof PrivyError && error.isMissingApproval) {
        throw new EnclaveApprovalRefusedError({
          policyId: request.subject,
          status: error.status,
          detail: error.code,
        });
      }
      throw error;
    }
  }

  /** The agent (signer) and mandate (owner) quorums: pinned from config, or created once per process. */
  quorums(): Promise<Quorums> {
    const { agentQuorumId, mandateQuorumId } = this.#options;
    if (agentQuorumId && mandateQuorumId)
      return Promise.resolve({ agentQuorumId, mandateQuorumId });
    this.#quorums ??= this.#createQuorums(agentQuorumId, mandateQuorumId).catch(
      (error: unknown) => {
        this.#quorums = undefined; // let the next call retry
        throw error;
      },
    );
    return this.#quorums;
  }

  async #createQuorums(agentId?: string, mandateId?: string): Promise<Quorums> {
    const create = (displayName: string, key: AuthorizationKey) =>
      createKeyQuorum(this.#client, { displayName, threshold: 1, publicKeys: [key.publicKey] });
    const quorums = {
      agentQuorumId: agentId ?? (await create('Sente agent key', this.#agentKey)).id,
      mandateQuorumId: mandateId ?? (await create('Sente mandate owner', this.#mandateOwnerKey)).id,
    };
    this.#options.onQuorumsCreated?.(quorums);
    return quorums;
  }

  #serial(walletId: string, method: EnclaveSignMethod, sign: () => Promise<Hex>): Promise<Hex> {
    const previous = this.#inflight.get(walletId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(sign)
      .catch((error: unknown) => {
        if (error instanceof PrivyError && error.isPolicyViolation) {
          const message = (error.body as { error?: unknown } | null)?.error;
          throw new EnclaveRefusedError({
            walletId,
            method,
            detail: typeof message === 'string' ? message : undefined,
          });
        }
        throw error;
      });
    this.#inflight.set(walletId, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.#inflight.get(walletId) === next) this.#inflight.delete(walletId);
      });
    return next;
  }
}
