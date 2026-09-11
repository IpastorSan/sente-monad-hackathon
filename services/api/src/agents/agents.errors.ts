/**
 * Agent-wallet failures that callers branch on. Plain `Error`s with no Nest
 * import, so scripts/privy-probe.ts can load them under node's type stripping;
 * the HTTP mapping belongs to whichever controller first exposes them.
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
