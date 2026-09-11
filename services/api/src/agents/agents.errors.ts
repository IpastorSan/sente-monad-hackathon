/**
 * Agent failures that callers branch on, and their HTTP mapping. Plain
 * `Error`s with NO Nest import, so scripts/privy-probe.ts can load this file
 * under node's type stripping (CLAUDE.md gotcha 10). That is why the mapper
 * returns a response body rather than an `HttpException`: the controller
 * wraps it.
 */

export type EnclaveSignMethod = 'eth_signTransaction' | 'eth_signTypedData_v4';

/**
 * The enclave evaluated the wallet's mandate policy and refused to sign.
 *
 * This is the mandate working, not an outage: nothing was signed, so nothing
 * can be broadcast, and retrying the same request will be refused again.
 * Privy's `policy_violation` never says WHICH rule failed (or that none
 * matched), so neither can this — `detail` is Privy's own message, verbatim.
 */
export class EnclaveRefusedError extends Error {
  readonly reason = 'policy_violation' as const;
  readonly walletId: string;
  readonly method: EnclaveSignMethod;
  /** Privy's error message, if it sent one. Carries no request data. */
  readonly detail: string | undefined;

  constructor(options: { walletId: string; method: EnclaveSignMethod; detail?: string }) {
    super(
      `enclave refused ${options.method} for wallet ${options.walletId}: policy_violation` +
        (options.detail ? ` (${options.detail})` : ''),
    );
    this.name = 'EnclaveRefusedError';
    this.walletId = options.walletId;
    this.method = options.method;
    this.detail = options.detail;
  }
}

/** Privy credentials are not configured, so no agent wallet can exist. */
export class AgentWalletsUnconfiguredError extends Error {
  readonly reason = 'agent_wallets_unconfigured' as const;

  constructor() {
    super(
      'agent wallets are not configured: set PRIVY_APP_ID and PRIVY_APP_SECRET, then run ' +
        '`pnpm --filter @sente/api run privy:keys` (docs/privy-policy-enforcement.md)',
    );
    this.name = 'AgentWalletsUnconfiguredError';
  }
}

/**
 * Every way an agents request can be refused. These strings are part of the
 * API contract — the mobile app branches on them — so treat renames as
 * breaking changes. Mirrors `wallet/wallet.errors.ts`.
 */
export const AGENT_REFUSAL_REASONS = [
  /** No such agent, OR it belongs to someone else: the two are indistinguishable, so ids don't leak. */
  'agent_not_found',
  /** `parseMandate` refused it, or it has already expired. The message names the field. */
  'mandate_invalid',
  /** The model is not in `AGENT_MODELS`. */
  'model_not_allowed',
  /** The agent is revoked. Revocation is permanent; hire a new agent. */
  'agent_revoked',
  /** The wallet provider failed to create the wallet or its policy. Nothing was stored. */
  'wallet_provision_failed',
  /**
   * The provider failed to replace the wallet's policy. On amend, the old
   * mandate still stands. On revoke, the agent IS revoked and will not run,
   * but its policy still holds the old rules until a retried revoke succeeds.
   */
  'wallet_policy_update_failed',
] as const;

export type AgentRefusalReason = (typeof AGENT_REFUSAL_REASONS)[number];

/**
 * A refusal is a domain outcome, not an HTTP concern: the service throws this
 * so it stays testable without a request context, and the controller maps it
 * to a status code exactly once.
 */
export class AgentRefusedError extends Error {
  readonly reason: AgentRefusalReason;

  constructor(reason: AgentRefusalReason, message: string) {
    super(message);
    this.name = 'AgentRefusedError';
    this.reason = reason;
  }
}

/** Every reason an agents route answers with: the refusals above plus the two wallet errors. */
export type AgentErrorReason =
  AgentRefusalReason | AgentWalletsUnconfiguredError['reason'] | EnclaveRefusedError['reason'];

const AGENT_ERROR_STATUS: Record<AgentErrorReason, number> = {
  agent_not_found: 404,
  mandate_invalid: 400,
  model_not_allowed: 400,
  // 409: the request is well-formed; the agent's state forbids it, for good.
  agent_revoked: 409,
  wallet_provision_failed: 502,
  wallet_policy_update_failed: 502,
  agent_wallets_unconfigured: 503,
  // The enclave refused to sign: the mandate working, not an outage.
  policy_violation: 403,
};

export function agentErrorStatus(reason: AgentErrorReason): number {
  return AGENT_ERROR_STATUS[reason];
}

/** The JSON body of a refused agents request. */
export interface AgentErrorBody {
  statusCode: number;
  reason: AgentErrorReason;
  message: string;
}

/**
 * Maps a typed agent error to its response body; `undefined` for anything
 * else, which the caller rethrows untouched.
 */
export function agentErrorToHttpBody(error: unknown): AgentErrorBody | undefined {
  if (
    !(error instanceof AgentRefusedError) &&
    !(error instanceof AgentWalletsUnconfiguredError) &&
    !(error instanceof EnclaveRefusedError)
  ) {
    return undefined;
  }
  return {
    statusCode: agentErrorStatus(error.reason),
    reason: error.reason,
    message: error.message,
  };
}
