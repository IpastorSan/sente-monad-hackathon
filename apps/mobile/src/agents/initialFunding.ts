/**
 * Funding an agent while hiring it (SEN-177), and the one funding path both
 * the hire flow and the agent page's Fund sheet take.
 *
 * The transfer itself is unchanged: `sendSponsored` out of the user's own
 * wallet, rebuilt and verified on this phone before the device key signs it.
 * What lives here is what surrounds it:
 *
 * - which tokens are worth offering for a given mandate,
 * - checking the typed amount against the account's balance,
 * - turning a send into one outcome a screen can show, never a throw,
 * - and the order: hire first, fund second. A failed funding never undoes or
 *   blocks the hire — the agent exists either way, and can be funded later.
 *
 * Plain node, no React Native, so `initialFunding.test.ts` runs without a device.
 */
import type { Address } from 'viem';

import { describeSendError, type SendIntent, type SentTransfer } from '../wallet/send.ts';
import { formatAtoms, parseAmount } from './amounts.ts';
import type { Agent, AgentMandate, HireAgentResult } from './api.ts';
import { needsDepositPin, type DepositPinState } from './depositPin.ts';
import { FUNDING_TOKENS, isNativeToken } from './fund.ts';
import { AUSD, PERPL_MIN_OPEN_ATOMS, type Token } from './mandate.ts';

/**
 * The tokens this mandate lets the agent put to work: each Kuru token it may
 * deposit (a token with no deposit cap can't reach Kuru at all) and AUSD when
 * it trades on Perpl. Native MON is left out: it is gas, and the agent's gas
 * is dripped to it. In `FUNDING_TOKENS` order, so USDC comes first.
 */
export function fundingTokensFor(mandate: Pick<AgentMandate, 'venues' | 'kuru'>): Token[] {
  const usable = new Set<string>();
  if (mandate.venues.includes('kuru')) {
    for (const address of Object.keys(mandate.kuru.maxDepositAtoms)) {
      usable.add(address.toLowerCase());
    }
  }
  if (mandate.venues.includes('perpl')) usable.add(AUSD.address.toLowerCase());
  return FUNDING_TOKENS.filter(
    (token) => !isNativeToken(token) && usable.has(token.address.toLowerCase()),
  );
}

/**
 * How "Fund it now" lays the offered tokens out (SEN-198). Without Perpl it
 * is one amount in one of `spot`'s tokens, as before. With Perpl, AUSD gets
 * its own amount beside the spot token's, so one hire can fund both venues:
 * `perps` is AUSD and `spot` is everything else (empty for a Perpl-only
 * mandate).
 */
export type FundingLayout = { spot: Token[]; perps: Token | null };

export function fundingLayout(
  mandate: Pick<AgentMandate, 'venues'>,
  tokens: readonly Token[],
): FundingLayout {
  const isAusd = (token: Token) => token.address.toLowerCase() === AUSD.address.toLowerCase();
  const perps = mandate.venues.includes('perpl') ? (tokens.find(isAusd) ?? null) : null;
  return { spot: perps ? tokens.filter((token) => !isAusd(token)) : [...tokens], perps };
}

/** What the AUSD amount starts at: Perpl's account-opening minimum, "100". */
export const PERPS_FUND_DEFAULT = formatAtoms(PERPL_MIN_OPEN_ATOMS, AUSD.decimals);

/**
 * The line under the AUSD amount. Said plainly whatever is typed, because an
 * agent hired with perps and less than the minimum just sits there.
 */
export function perpsFundNote(check: FundingCheck): string {
  const rule = `Perps won’t open until the agent holds at least ${PERPS_FUND_DEFAULT} AUSD.`;
  if (check.kind === 'ok' && check.atoms < PERPL_MIN_OPEN_ATOMS) {
    return `${rule} This alone won’t open them; you can top it up later.`;
  }
  return rule;
}

export type FundingCheck =
  /** Nothing typed, or zero: fund later. */
  { kind: 'skip' } | { kind: 'ok'; atoms: bigint } | { kind: 'invalid'; error: string };

/**
 * The amount as typed, against what the account holds. `balance` is `null`
 * while it is still being read; the amount is then accepted as far as its
 * format goes, and the send itself is the last word.
 */
export function checkFunding(amount: string, token: Token, balance: bigint | null): FundingCheck {
  if (amount.trim() === '') return { kind: 'skip' };
  const atoms = parseAmount(amount, token.decimals);
  if (atoms === null) {
    return {
      kind: 'invalid',
      error: `Enter an amount with at most ${token.decimals} decimals.`,
    };
  }
  if (atoms === 0n) return { kind: 'skip' };
  if (balance !== null && atoms > balance) {
    return {
      kind: 'invalid',
      error: `More than your account holds (${formatAtoms(balance, token.decimals)} ${token.symbol}).`,
    };
  }
  return { kind: 'ok', atoms };
}

export type FundingOutcome =
  | { kind: 'sent'; label: string; transactionHash?: string }
  /** Submitted, not confirmed: the money may well move. Never a failure. */
  | { kind: 'submitted'; label: string; status: string }
  | { kind: 'failed'; label: string; title: string; detail: string };

export type FundingState = { kind: 'funding'; label: string } | FundingOutcome;

export function fundingLabel(atoms: bigint, token: Token): string {
  return `${formatAtoms(atoms, token.decimals)} ${token.symbol}`;
}

/** A finished send, as one outcome. Gotcha 8: `reverted` moved nothing. */
export function fundingOutcome(sent: SentTransfer, label: string): FundingOutcome {
  const status = sent.confirmation?.status ?? sent.status;
  const transactionHash = sent.confirmation?.transactionHash ?? sent.transactionHash;
  if (status === 'included') {
    return { kind: 'sent', label, ...(transactionHash ? { transactionHash } : {}) };
  }
  if (status === 'reverted') {
    return {
      kind: 'failed',
      label,
      title: 'The transfer reverted',
      detail: 'It was included on chain but didn’t execute, so nothing moved.',
    };
  }
  return { kind: 'submitted', label, status };
}

/** One transfer to make after the hire. */
export type FundingRequest = { token: Token; atoms: bigint };

/** The amounts worth sending, in the order given: skipped and invalid ones are left out. */
export function fundingRequests(
  entries: readonly { token: Token; check: FundingCheck }[],
): FundingRequest[] {
  return entries.flatMap(({ token, check }) =>
    check.kind === 'ok' ? [{ token, atoms: check.atoms }] : [],
  );
}

export type Send = (intent: SendIntent) => Promise<SentTransfer>;

/** Send `atoms` of `token` to `to`, as one outcome: this never throws. */
export async function fundAgent(
  send: Send,
  intent: { walletId: string; token: Token; to: Address; atoms: bigint },
): Promise<FundingOutcome> {
  const label = fundingLabel(intent.atoms, intent.token);
  try {
    return fundingOutcome(await send(intent), label);
  } catch (caught) {
    return { kind: 'failed', label, ...describeSendError(caught) };
  }
}

/**
 * Hire, secure the deposits, then fund. A hire that fails throws, exactly as
 * hiring did before; a pin or a funding that fails is reported through its own
 * callback and nothing else, after `onHired` has already shown the agent.
 *
 * The pin (SEN-188) runs only when the API says the agent needs it, and before
 * the funding: it is the step that finishes the hire's policy, and the funding
 * goes to the agent's wallet, which it does not touch either way.
 *
 * Each funding request is sent one after the other (SEN-198: USDC, then AUSD),
 * and reported by its index. One failing does not stop the next: they are
 * separate transfers of separate tokens.
 */
export async function hireThenFund(steps: {
  hire: () => Promise<HireAgentResult>;
  /** Empty: nothing to fund. */
  funding: readonly FundingRequest[];
  fund: (to: Address, token: Token, atoms: bigint) => Promise<FundingOutcome>;
  onHired: (result: HireAgentResult) => void;
  onFunding: (index: number, state: FundingState) => void;
  /** The pinning amend (`secureDeposits`); never throws. */
  secure?: (agent: Agent) => Promise<DepositPinState>;
  onSecure?: (state: DepositPinState) => void;
}): Promise<void> {
  const result = await steps.hire();
  steps.onHired(result);
  if (steps.secure && needsDepositPin(result.agent)) {
    steps.onSecure?.({ kind: 'securing' });
    steps.onSecure?.(await steps.secure(result.agent));
  }
  for (const [index, { token, atoms }] of steps.funding.entries()) {
    const label = fundingLabel(atoms, token);
    steps.onFunding(index, { kind: 'funding', label });
    try {
      steps.onFunding(index, await steps.fund(result.agent.address, token, atoms));
    } catch (caught) {
      steps.onFunding(index, { kind: 'failed', label, ...describeSendError(caught) });
    }
  }
}
