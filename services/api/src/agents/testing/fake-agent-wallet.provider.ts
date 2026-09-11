import type { PolicyRule } from '@sente/mandate';
import { getAddress, type Hex } from 'viem';

import type {
  AgentWalletProvider,
  ProvisionAgentWalletInput,
  ProvisionedAgentWallet,
} from '../agent-wallet.provider';

/**
 * An in-memory `AgentWalletProvider` for specs: no network, no Privy, no .env.
 * It records every call and holds each policy's current rules the way the
 * enclave would, so a spec can assert on what the wallet may sign right now.
 */
export class FakeAgentWalletProvider implements AgentWalletProvider {
  readonly name = 'fake';
  readonly provisioned: ProvisionAgentWalletInput[] = [];
  readonly policyUpdates: { policyId: string; rules: readonly PolicyRule[] }[] = [];
  /** policyId -> the rules currently in force. */
  readonly policies = new Map<string, readonly PolicyRule[]>();

  /** Set to make the next calls fail. */
  provisionError: Error | undefined;
  updatePolicyError: Error | undefined;
  /** Awaited at the start of every `updatePolicy`, to hold one in flight. */
  beforeUpdatePolicy: (() => Promise<void>) | undefined;

  private sequence = 0;

  provision(input: ProvisionAgentWalletInput): Promise<ProvisionedAgentWallet> {
    if (this.provisionError) return Promise.reject(this.provisionError);
    this.provisioned.push(input);
    const n = ++this.sequence;
    const policyId = `policy-${n}`;
    this.policies.set(policyId, input.rules);
    return Promise.resolve({
      walletId: `wallet-${n}`,
      address: getAddress(`0x${n.toString(16).padStart(40, 'a')}`),
      policyId,
    });
  }

  signTransaction(): Promise<Hex> {
    return Promise.reject(new Error('FakeAgentWalletProvider does not sign'));
  }

  signTypedData(): Promise<Hex> {
    return Promise.reject(new Error('FakeAgentWalletProvider does not sign'));
  }

  async updatePolicy(policyId: string, rules: readonly PolicyRule[]): Promise<void> {
    await this.beforeUpdatePolicy?.();
    if (this.updatePolicyError) throw this.updatePolicyError;
    if (!this.policies.has(policyId)) throw new Error(`unknown policy ${policyId}`);
    this.policyUpdates.push({ policyId, rules });
    this.policies.set(policyId, rules);
  }
}
