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

/**
 * The enclave refused the APPROVAL, not the request: a signature over other
 * bytes, or one made by a key outside the policy's owner quorum (Privy answers
 * 401/403). SEN-44's refusal, and the one the demo shows — a mandate change
 * signed by anything but the owner's phone does not happen.
 *
 * Distinct from `wallet_policy_update_failed`, which is the enclave being
 * unreachable or unhappy for any other reason: this one says the caller did not
 * authorise what they asked for, and no retry of the same bytes will help.
 */
export class EnclaveApprovalRefusedError extends Error {
  readonly reason = 'mandate_approval_refused' as const;
  /** Privy's status, 401 or 403. */
  readonly status: number;

  constructor(options: { policyId: string; status: number; detail?: string }) {
    super(
      `the enclave refused the approval for policy ${options.policyId} (${options.status}): ` +
        'the signature must be the policy owner’s, over exactly this request' +
        (options.detail ? ` (${options.detail})` : ''),
    );
    this.name = 'EnclaveApprovalRefusedError';
    this.status = options.status;
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
   * The caller has no registered user wallet, so there is no device-key quorum
   * to own the new agent's mandate (SEN-43). `POST /wallet/register` first. Only
   * reachable in `device` mode — `AGENT_MANDATE_OWNER=server` skips the lookup.
   */
  'wallet_not_registered',
  /**
   * The provider failed to replace the wallet's policy. On amend, the old
   * mandate still stands. On revoke, the agent IS revoked and will not run,
   * but its policy still holds the old rules until a retried revoke succeeds.
   */
  'wallet_policy_update_failed',
  /**
   * This agent's mandate is owned by its hirer's phone (`ownerKind: 'device'`,
   * SEN-43), so amending or revoking it needs a signature from that phone. Ask
   * `POST /agents/:id/mandate/prepare` (or `/revoke/prepare`), have the device
   * key sign the payload it returns, and send it back with the prepare id.
   */
  'mandate_approval_required',
  /**
   * The opposite: a prepared, phone-signed change was offered for a
   * `ownerKind: 'server'` agent, whose policy this server owns and signs for.
   * There is nothing for the phone to approve; use the one-step route.
   */
  'mandate_approval_not_required',
  /**
   * The prepare id is unknown, already used, or past its TTL. Prepared changes
   * are single-use and short-lived: prepare again and sign the new payload.
   */
  'mandate_prepare_not_found',
  /**
   * A hire, fork or amend carried a `returnTo` that is not the caller's own
   * wallet (SEN-17). The exit address is resolved server-side from the user
   * wallet registry, and a client value is only ever compared with it — never
   * trusted — so the honest answer to a different one is "no".
   */
  'return_address_mismatch',
  /**
   * The same, when the caller has no registered wallet at all: there is nothing
   * to compare the client's `returnTo` with, so it is refused rather than
   * honoured. `POST /wallet/register` first. Omitting `returnTo` is fine and
   * compiles an agent with no exit rule.
   */
  'return_address_unavailable',
  /**
   * `POST /agents/:id/return` on an agent whose mandate names no `returnTo`, so
   * its policy has no transfer rule and the enclave would refuse the transfer.
   * Amend the mandate (an active agent) — a revoked one can only be emptied
   * with the owner key, by hand.
   */
  'return_address_missing',
  /** `POST /agents/:id/return` named an asset no agent wallet can hold. */
  'return_asset_not_supported',
  /** `POST /agents/:id/return`'s `amount` is not a positive decimal, or names no asset. */
  'return_amount_invalid',
  /**
   * The agent has too little MON to pay for the withdraw and transfer it would
   * take to send its funds home. Monad charges the gas LIMIT (gotcha 4), so the
   * message names the exact shortfall and the `agent:fund` command for it.
   */
  'return_gas_insufficient',
  /** `POST /agents/:id/run` while a run of the same agent is still going (SEN-8). One at a time. */
  'run_in_progress',
  /**
   * The run stopped because the owner's OpenRouter key is out of budget: a 402
   * from OpenRouter, or a key whose `limit_remaining` is 0. The body carries
   * the run. It resets with the key's monthly limit.
   */
  'credits_exhausted',
  /** The run stopped on any other model API failure. The body carries the run. */
  'model_error',
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
  | AgentRefusalReason
  | AgentWalletsUnconfiguredError['reason']
  | EnclaveRefusedError['reason']
  | EnclaveApprovalRefusedError['reason'];

const AGENT_ERROR_STATUS: Record<AgentErrorReason, number> = {
  agent_not_found: 404,
  mandate_invalid: 400,
  model_not_allowed: 400,
  // 409: the request is well-formed; the agent's state forbids it, for good.
  agent_revoked: 409,
  wallet_provision_failed: 502,
  // 409: the request is well-formed, the caller's account is just not ready for
  // it yet. Registering a wallet makes the same request succeed.
  wallet_not_registered: 409,
  wallet_policy_update_failed: 502,
  // 409: well-formed, and the agent's owner model forbids answering it this
  // way. Both are fixed by using the other route, not by retrying.
  mandate_approval_required: 409,
  mandate_approval_not_required: 409,
  // 404: the prepared change is gone — unknown id, already committed, or
  // expired. Nothing to commit against.
  mandate_prepare_not_found: 404,
  // 400: the body said something about the exit address that cannot be true.
  return_address_mismatch: 400,
  return_asset_not_supported: 400,
  return_amount_invalid: 400,
  // 409: well-formed, and the account's or agent's state forbids it for now.
  // Registering a wallet, or amending the mandate, makes the same call work.
  return_address_unavailable: 409,
  return_address_missing: 409,
  // 409: the agent is simply out of gas. Funding it makes the same call work.
  return_gas_insufficient: 409,
  run_in_progress: 409,
  // 402 Payment Required: exactly what OpenRouter itself answered.
  credits_exhausted: 402,
  model_error: 502,
  agent_wallets_unconfigured: 503,
  // The enclave refused to sign: the mandate working, not an outage.
  policy_violation: 403,
  // 403: the enclave refused the approval. The owner did not authorise this
  // request, so it is a permission answer, not a gateway one.
  mandate_approval_refused: 403,
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
    !(error instanceof EnclaveRefusedError) &&
    !(error instanceof EnclaveApprovalRefusedError)
  ) {
    return undefined;
  }
  return {
    statusCode: agentErrorStatus(error.reason),
    reason: error.reason,
    message: error.message,
  };
}
