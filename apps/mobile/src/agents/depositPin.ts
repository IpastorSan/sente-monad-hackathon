/**
 * Securing a new agent's Kuru deposits (SEN-188): the one amend every hire
 * needs.
 *
 * Kuru's AccountCore credits whichever account a `deposit` names, and the hire
 * cannot pin that to the agent: Privy creates the policy before the wallet, so
 * the address is unknown when the rules are compiled. Until the policy is
 * re-PATCHed with the agent's own wallet as `deposit.rootOwner`, the agent's
 * deposit rule could credit any Kuru account. The API refuses every Kuru
 * deposit meanwhile (`kuruDepositPinned: false`), so nothing is lost by the
 * gap — but the agent cannot fund Kuru until it is closed.
 *
 * Closing it is an ordinary amend with the SAME mandate:
 *
 * - device-owned (the normal case): prepare → verify → sign → commit, through
 *   `amendMandateWithApproval`, so the phone checks the pinned rules against
 *   the mandate it holds — the pin must name THIS agent's wallet, and nothing
 *   else may change — before the device key, already in the session (SEN-176),
 *   signs. No passkey prompt.
 * - server-owned: the API pins it itself right after the hire; if that failed,
 *   the one-step amend retries it.
 *
 * Plain TS, no React Native, so `depositPin.test.ts` runs under plain node.
 */
import type { Address } from 'viem';

import type { Agent, AgentMandate, AgentsApi } from './api.ts';
import { amendMandateWithApproval, describeApprovalError, needsApproval } from './approval.ts';
import type { Approver } from '../auth/privyApproval.ts';

export type DepositPinState =
  | { kind: 'securing' }
  | { kind: 'secured'; agent: Agent }
  | { kind: 'failed'; title: string; detail: string };

/**
 * Whether this agent still waits for its pinning amend. Only an explicit
 * `false`: an API that predates the field sends nothing, and an agent with no
 * Kuru deposit to pin reads `true`.
 */
export function needsDepositPin(agent: Pick<Agent, 'status' | 'kuruDepositPinned'>): boolean {
  return agent.status === 'active' && agent.kuruDepositPinned === false;
}

/**
 * The pinning amend, as one outcome: this never throws.
 *
 * `mandate` is the one to keep. Right after a hire it is the mandate this phone
 * just sent, not the API's echo of it; from the agent page it is the stored
 * one, whose `returnTo` the approval still checks against `ownWallet`.
 */
export async function secureDeposits(deps: {
  api: AgentsApi;
  agent: Agent;
  mandate: AgentMandate;
  ownWallet: Address | null;
  sign: Approver | null;
}): Promise<Exclude<DepositPinState, { kind: 'securing' }>> {
  const { api, agent, mandate, ownWallet, sign } = deps;
  try {
    const updated = needsApproval(agent)
      ? await amendMandateWithApproval(api, agent, mandate, ownWallet, sign)
      : await api.amendMandate(agent.id, mandate);
    if (updated.kuruDepositPinned === false) {
      return {
        kind: 'failed',
        title: 'Deposits still aren’t secured',
        detail: 'The policy was updated, but the API still reports the deposit unpinned.',
      };
    }
    return { kind: 'secured', agent: updated };
  } catch (caught) {
    return { kind: 'failed', ...describeApprovalError(caught) };
  }
}
