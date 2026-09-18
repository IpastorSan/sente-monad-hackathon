import type { PolicyRule } from '@sente/mandate';
import { getAddress, type Hex } from 'viem';

import type {
  AgentWalletProvider,
  EnclaveApproval,
  EnclaveRequest,
  PreparedEnclaveRequest,
  ProvisionAgentWalletInput,
  ProvisionedAgentWallet,
} from '../agent-wallet.provider';
import { EnclaveApprovalRefusedError } from '../agents.errors';
import { policyPath, policyRulesBody } from '../privy/policies';
import { PrivyClient } from '../privy/privy.client';

/** Builds the payloads only; nothing here ever reaches the network. */
const FAKE_PAYLOADS = new PrivyClient({ appId: 'fake-app', appSecret: 'fake-secret' });

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

  /**
   * The signature every `commitPrepared` must carry to be accepted, standing
   * in for the owner quorum Privy checks. A spec sets it to whatever its fake
   * phone produces; anything else is refused the way Privy refuses it.
   */
  acceptedSignature = 'device-signature';

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
    this.applyRules(policyId, rules);
  }

  /**
   * The same request the real provider would send, down to the URL and body,
   * so a spec can assert on the exact bytes the phone is asked to sign.
   */
  /**
   * The same request the real provider would send, built by the same two
   * functions and the same payload builder — a fake that composed its own bytes
   * would keep passing after the real shape changed.
   */
  preparePolicyUpdate(
    policyId: string,
    rules: readonly PolicyRule[],
  ): Promise<PreparedEnclaveRequest> {
    const path = policyPath(policyId);
    const body = policyRulesBody({ rules });
    return Promise.resolve({
      request: { method: 'PATCH', path, body, subject: policyId },
      // No fetch is made from this client; it is here for `authorizationPayload`,
      // which is pure.
      payload: FAKE_PAYLOADS.authorizationPayload('PATCH', path, body),
    });
  }

  async commitPrepared(request: EnclaveRequest, approval: EnclaveApproval): Promise<void> {
    await this.beforeUpdatePolicy?.();
    if (this.updatePolicyError) throw this.updatePolicyError;
    if (approval.signature !== this.acceptedSignature) {
      throw new EnclaveApprovalRefusedError({ policyId: request.subject, status: 401 });
    }
    const { rules } = request.body as { rules: readonly PolicyRule[] };
    this.applyRules(request.subject, rules);
  }

  private applyRules(policyId: string, rules: readonly PolicyRule[]): void {
    if (!this.policies.has(policyId)) throw new Error(`unknown policy ${policyId}`);
    this.policyUpdates.push({ policyId, rules });
    this.policies.set(policyId, rules);
  }
}
