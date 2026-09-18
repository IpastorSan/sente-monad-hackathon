import type { AuthorizationPayload, PolicyRule } from '@sente/mandate';
import type { Address, Hex, TypedDataDefinition } from 'viem';

import { AgentWalletsUnconfiguredError } from './agents.errors.ts';
import type { PrivyTransactionRequest } from './privy/agent-wallet.ts';

/** DI token for the agent wallet provider. */
export const AGENT_WALLETS = Symbol('AGENT_WALLETS');

export interface ProvisionAgentWalletInput {
  /** The compiled mandate — `compileMandate(mandate)` from `@sente/mandate`. */
  rules: readonly PolicyRule[];
  /** Shown in the provider's dashboard. Truncated to 50 characters. */
  displayName: string;
  /**
   * The quorum that will OWN both the policy and the wallet (SEN-43). Set it to
   * the hirer's device-key quorum and this server can never change that agent's
   * mandate again — creating the policy needs no owner signature, changing one
   * does. Unset keeps the provider's own mandate quorum, which is the pre-SEN-43
   * behaviour and what the scripted demo and the specs use.
   *
   * It never affects who SIGNS: the trading key stays an additional signer
   * either way (SEN-31).
   */
  ownerQuorumId?: string;
}

export interface ProvisionedAgentWallet {
  walletId: string;
  /** EIP-55 checksummed. */
  address: Address;
  policyId: string;
}

/**
 * One mutation at the enclave, held still so somebody else can approve it
 * (SEN-44).
 *
 * `path` and `body` are what goes on the wire, verbatim, at commit time — not a
 * recipe for rebuilding them. An approval signature covers the method, the URL
 * and the body byte for byte, so anything recomputed between the prepare and
 * the commit is a signature that no longer verifies, and, worse, a place where
 * the approved request and the sent request could differ.
 */
export interface EnclaveRequest {
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  /** Path under the provider's API base, e.g. `/v1/policies/xyz`. */
  readonly path: string;
  readonly body: unknown;
}

/** An {@link EnclaveRequest} and the payload its owner must sign to authorise it. */
export interface PreparedEnclaveRequest {
  readonly request: EnclaveRequest;
  readonly payload: AuthorizationPayload;
}

/** One approval made outside this process: base64 DER, as Privy's header carries it. */
export interface EnclaveApproval {
  readonly signature: string;
}

/**
 * Custody for an agent's trading key, behind an interface for the same two
 * reasons as `wallet/bundler/bundler.ts`: it is the only piece of `agents/`
 * that must reach the network, so everything above it is testable with a fake;
 * and the enclave vendor is swappable. Privy is the implementation today
 * (`privy/privy-agent-wallet.provider.ts`).
 *
 * The contract every implementation keeps:
 *
 * - The key never leaves the provider. Signing returns a signature or a signed
 *   transaction; nothing is ever broadcast from here.
 * - A policy refusal throws `EnclaveRefusedError` (`agents.errors.ts`) and
 *   nothing else does — callers branch on it.
 * - `updatePolicy` is authorised by the mandate-owner key, a DIFFERENT key from
 *   the one that signs trades. The trading key is only a wallet SIGNER (SEN-31),
 *   never the owner, so it can neither change the policy nor PATCH the wallet to
 *   detach it: the key that spends can never raise its own limit.
 * - `provision` takes the owner quorum from its caller (SEN-43). When that is
 *   the hirer's device quorum, `updatePolicy` on the resulting policy will be
 *   refused with a 401 for THIS server too — by design; SEN-44 collects the
 *   phone's signature instead.
 */
export interface AgentWalletProvider {
  /** Human-readable, for logs. */
  readonly name: string;

  /** A new wallet governed by a new policy holding `rules`, both set at creation. */
  provision(input: ProvisionAgentWalletInput): Promise<ProvisionedAgentWallet>;

  /** A raw signed transaction, ready for `eth_sendRawTransaction`. */
  signTransaction(walletId: string, tx: PrivyTransactionRequest): Promise<Hex>;

  /** An EIP-712 signature (`eth_signTypedData_v4`). */
  signTypedData(walletId: string, typed: TypedDataDefinition): Promise<Hex>;

  /** Replace the policy's rules. Signed by the mandate-owner key, not the agent key. */
  updatePolicy(policyId: string, rules: readonly PolicyRule[]): Promise<void>;

  /**
   * The same replacement, held still for an owner this process cannot sign
   * for (SEN-44): the exact request, and the payload the owner's phone signs.
   *
   * Sends nothing. A prepare that reached the enclave would be a mandate change
   * without an approval, which is the one thing this pair exists to prevent.
   */
  preparePolicyUpdate(
    policyId: string,
    rules: readonly PolicyRule[],
  ): Promise<PreparedEnclaveRequest>;

  /**
   * Send a prepared request, carrying an approval made elsewhere.
   *
   * Throws {@link EnclaveApprovalRefusedError} when the enclave refuses the
   * approval itself — a signature over other bytes, a key outside the owner
   * quorum, a replay past a nonce — so a caller can tell "you did not approve
   * this" from "the enclave is down".
   */
  commitPrepared(request: EnclaveRequest, approval: EnclaveApproval): Promise<void>;
}

/**
 * Bound when Privy is not configured, so the API still boots (health, wallet,
 * credits) and anything that needs an agent wallet fails loudly and typed —
 * the same call `wallet/paymaster` makes with `UnconfiguredSponsorship`.
 */
export class UnconfiguredAgentWalletProvider implements AgentWalletProvider {
  readonly name = 'unconfigured';

  provision(): Promise<ProvisionedAgentWallet> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
  signTransaction(): Promise<Hex> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
  signTypedData(): Promise<Hex> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
  updatePolicy(): Promise<void> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
  preparePolicyUpdate(): Promise<PreparedEnclaveRequest> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
  commitPrepared(): Promise<void> {
    return Promise.reject(new AgentWalletsUnconfiguredError());
  }
}
