/**
 * Turns a confirmed Perpl onboarding into the steps the phone will sign
 * (SEN-99, plan M-T17, "Architecture §3").
 *
 * Onboarding is `approve(Exchange, amount)` → `createAccount(amount)` →
 * `allowOrderForwarding(true)`, built by the same `perplOnboardingCalls` the
 * agents use. For a user the SENDER is the Privy wallet itself, a plain
 * secp256k1 account even after its EIP-7702 delegation, so the Perpl account it
 * opens can later enroll API keys (CLAUDE.md gotcha 9; plan §3).
 *
 * It RESUMES: an account that already exists skips the first two legs, and
 * forwarding known to be on skips the third. That leaves 3, 1 or 0 legs.
 *
 * The output follows the Kuru planner's rules for the phone's strict checks
 * (M-T16), and is packed by the very same {@link packSteps}:
 *
 * - legs run exactly `[perpl.approve?, perpl.createAccount?, perpl.allowForwarding]`,
 *   each step's kind naming its one call;
 * - `approve` is for the account-opening amount exactly — `createAccount`
 *   pulls all of it, so nothing stays approved;
 * - no leg carries `value`;
 * - with `atomicBatch` and more than one leg, one `batch` self-call.
 *
 * Erasable syntax and `.ts` specifiers (gotcha 10), like `kuru-planner.ts`, so
 * the phone's cross-side contract test can run it.
 */

import {
  onboardingParams,
  PERPL_TESTNET_CONTRACTS,
  perplOnboardingCalls,
  type PerplContext,
} from '@sente/venues/perpl';
import { erc20Abi, formatUnits, isAddressEqual, type Address, type PublicClient } from 'viem';

import { perplAccountInfo } from '../agents/venues/perpl-agent.ts';
import { packSteps, type PlannedStep } from './kuru-planner.ts';
import type { StepKind } from './trade-store.ts';

/** Plan "Shared wire types". `amountAtoms` is AUSD atoms (6 decimals). */
export type PerplOnboardIntent = {
  kind: 'perpl.onboard';
  clientTradeId: string;
  amountAtoms: string;
};

export type PerplPlannerDeps = {
  readonly client: PublicClient;
  /** The user's Privy wallet: the sender, and so the Perpl account's owner. */
  readonly wallet: Address;
  /** The live `GET /v1/pub/context`: the Exchange, AUSD and the opening minimum. */
  readonly context: PerplContext;
  /** `TradeConfig.atomicBatch`. */
  readonly atomicBatch: boolean;
  /**
   * Whether the account already allows order forwarding: `true` skips the
   * third leg; `false` or `null` (unknown) keeps it. Forwarding is not in the
   * Exchange's `getAccountByAddr` tuple (verified on testnet: an account with
   * forwarding on reads the same words as one without) — only Perpl's
   * authenticated socket reports it (`PerplAccount.fw`). Re-sending
   * `allowOrderForwarding(true)` is harmless, so an unknown answer costs one
   * sponsored transaction, never a stuck account.
   */
  readonly forwarding: boolean | null;
};

export type PerplPlan = {
  readonly steps: readonly PlannedStep[];
  /** Render only. */
  readonly summary: Record<string, string>;
};

/**
 * `perpl_already_onboarded` has no plan to sign; `below_min_account_open`
 * (the plan names none for Perpl's opening minimum, and "notional" would be
 * wrong for a deposit) and the others mirror the Kuru planner's reasons.
 */
export type PerplPlanRefusalReason =
  'invalid_intent' | 'below_min_account_open' | 'insufficient_balance' | 'perpl_already_onboarded';

export class PerplPlanRefusedError extends Error {
  readonly reason: PerplPlanRefusalReason;

  // Assigned in the body, not a parameter property: erasable syntax only.
  constructor(reason: PerplPlanRefusalReason, message: string) {
    super(message);
    this.name = 'PerplPlanRefusedError';
    this.reason = reason;
  }
}

export async function planPerplOnboard(
  intent: PerplOnboardIntent,
  deps: PerplPlannerDeps,
): Promise<PerplPlan> {
  if (typeof intent.amountAtoms !== 'string' || !/^\d{1,78}$/.test(intent.amountAtoms)) {
    throw new PerplPlanRefusedError('invalid_intent', 'amountAtoms is not a whole number of atoms');
  }
  const amount = BigInt(intent.amountAtoms);
  const params = perplParams(deps.context);
  const symbol = collateralSymbol(deps.context);
  const shown = `${formatUnits(amount, params.collateralDecimals)} ${symbol}`;

  const account = await perplAccountInfo(deps.client, deps.wallet, params.exchange);
  if (!account) await assertCanOpen(amount, params, symbol, deps);
  // With an account open only `forward` is used, and the amount is moot.
  const [approve, create, forward] = perplOnboardingCalls(
    params,
    account ? params.minAccountOpenAmount : amount,
  );

  const legs: { kind: StepKind; title: string; call: typeof forward }[] = [];
  if (!account) {
    legs.push({ kind: 'perpl.approve', title: `Approve ${shown} for Perpl`, call: approve });
    legs.push({
      kind: 'perpl.createAccount',
      title: `Open a Perpl account with ${shown}`,
      call: create,
    });
  }
  if (deps.forwarding !== true) {
    legs.push({
      kind: 'perpl.allowForwarding',
      title: 'Allow Perpl order forwarding',
      call: forward,
    });
  }
  if (legs.length === 0) {
    throw new PerplPlanRefusedError(
      'perpl_already_onboarded',
      `Perpl account ${account!.accountId} is open and forwards orders; nothing to sign`,
    );
  }

  return {
    steps: packSteps(
      legs,
      deps,
      account ? 'Allow Perpl order forwarding' : `Open Perpl with ${shown}`,
    ),
    summary: {
      venue: 'perpl',
      ...(account
        ? { accountId: account.accountId.toString() }
        : { deposit: formatUnits(amount, params.collateralDecimals) }),
      collateral: symbol,
      minOpen: formatUnits(params.minAccountOpenAmount, params.collateralDecimals),
      resumed: String(account !== null),
    },
  };
}

/**
 * The live onboarding parameters, pinned to the contracts the phone accepts.
 * The phone's verifier (M-T16) allows `approve` only toward the Exchange in its
 * own table, so a context naming another Exchange or collateral would produce
 * steps it refuses — say why here instead, as the agent path does.
 */
export function perplParams(context: PerplContext) {
  const params = onboardingParams(context);
  if (
    !isAddressEqual(params.exchange, PERPL_TESTNET_CONTRACTS.exchange) ||
    !isAddressEqual(params.collateral, PERPL_TESTNET_CONTRACTS.collateral)
  ) {
    throw new Error(
      'Perpl context names a different Exchange or collateral than PERPL_TESTNET_CONTRACTS',
    );
  }
  return params;
}

async function assertCanOpen(
  amount: bigint,
  params: ReturnType<typeof perplParams>,
  symbol: string,
  deps: PerplPlannerDeps,
): Promise<void> {
  const minimum = params.minAccountOpenAmount;
  if (amount < minimum) {
    throw new PerplPlanRefusedError(
      'below_min_account_open',
      `Perpl needs at least ${formatUnits(minimum, params.collateralDecimals)} ${symbol} ` +
        `to open an account, got ${formatUnits(amount, params.collateralDecimals)}`,
    );
  }
  // `createAccount` pulls the deposit with `transferFrom`; short of it, the
  // step reverts on chain and Monad still charges its gas limit (gotcha 4).
  const balance = await deps.client.readContract({
    address: params.collateral,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [deps.wallet],
  });
  if (balance < amount) {
    throw new PerplPlanRefusedError(
      'insufficient_balance',
      `the wallet holds ${formatUnits(balance, params.collateralDecimals)} ${symbol}, ` +
        `short of ${formatUnits(amount, params.collateralDecimals)}`,
    );
  }
}

function collateralSymbol(context: PerplContext): string {
  const id = context.instances[0]?.collateral_token_id;
  return context.tokens.find((t) => t.id === id)?.symbol ?? 'AUSD';
}
