import type { PolicyRule } from '@sente/mandate';
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
}

export interface ProvisionedAgentWallet {
  walletId: string;
  /** EIP-55 checksummed. */
  address: Address;
  policyId: string;
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
}
