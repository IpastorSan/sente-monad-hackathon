/**
 * Withdrawing from the app (SEN-153): the rules behind the Portfolio cash
 * card's two money-out flows, with no React Native so `withdraw.test.ts` runs
 * under plain node.
 *
 * 1. **Your wallet → an address you type.** A sponsored send
 *    (`wallet/send.ts#sendSponsored`), which already rebuilds the Privy payload
 *    from the intent and refuses to sign anything else. What this module adds
 *    is everything BEFORE the intent exists: which tokens, what Max means, what
 *    counts as a recipient, what deserves a second look, and the review copy.
 * 2. **Kuru account → your wallet.** A `kuru.withdraw` intent through
 *    `trade/flow.ts#runTrade`. AccountCore's `withdraw` pays `msg.sender`, so
 *    there is no recipient to choose or to get wrong; only token and amount.
 *
 * MON is not offered on the send side at all. Monad keeps a 10 MON reserve
 * per account (CLAUDE.md gotcha 12) and an EIP-7702-delegated wallet — which
 * the user's becomes on its first sponsored send — cannot go below it at all,
 * so a MON withdrawal would either revert (charged the gas limit) or need a
 * reserve calculation the phone cannot do honestly. Gas is sponsored, so the
 * user never needs MON to withdraw the stablecoins that are their cash.
 */
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';

import { formatAtoms, parseAmount } from '../agents/amounts.ts';
import { AUSD, KURU_TOKENS, type Token } from '../agents/mandate.ts';
import type { BalanceDto } from '../agents/api.ts';
import { WalletApiError } from '../wallet/api.ts';
import type { ConfirmationStatus } from '../wallet/confirmation.ts';
import { describeSendError } from '../wallet/send.ts';
import { shortAddress } from '../ui/format.ts';

const USDC = KURU_TOKENS.find((token) => token.symbol === 'USDC') as Token;

/** What the wallet → address sheet offers: the two stablecoins, never MON (see header). */
export const WITHDRAW_TOKENS: readonly Token[] = [USDC, AUSD];

/**
 * Whether the Portfolio cash card offers "Withdraw" (your wallet → an address
 * you type). OFF, deliberately: the API's `POST /wallet/send/prepare` only
 * composes transfers to the caller's own wallet or one of their agents and
 * refuses anything else with `send_recipient_not_allowed` (SEN-42,
 * `services/api/src/wallet/user-wallet.service.ts#recipientOrRefuse`). A flow
 * the server always refuses is not shipped. Turning this on needs a
 * server-side decision to allow outside recipients first — that rule also
 * bounds what a stolen device key can move through our API — and only then
 * this flag. The sheet, its rules and their tests stay ready for that day.
 * The Kuru account → wallet flow is not behind this flag.
 */
export const EXTERNAL_WITHDRAW_ENABLED = false;

/**
 * What can leave the Kuru account through `kuru.withdraw`: the cash the card
 * shows that is also a Kuru token. AUSD is Perpl's collateral and never sits
 * in AccountCore, and the planner refuses a token Kuru does not list.
 */
export const KURU_WITHDRAW_TOKENS: readonly Token[] = [USDC];

// ─── Amount ─────────────────────────────────────────────────────────────────

export type AmountCheck =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'zero'; readonly message: string }
  | { readonly kind: 'too_much'; readonly atoms: bigint; readonly message: string }
  | { readonly kind: 'ok'; readonly atoms: bigint };

/**
 * The typed amount against what can leave. `available === null` means the
 * balance is not read yet: an amount is still parsed, but never called `ok`
 * over a balance nobody has seen — the confirm stays disabled rather than
 * letting the server or the chain be the first to say no.
 */
export function checkAmount(input: string, token: Token, available: bigint | null): AmountCheck {
  if (input.trim() === '') return { kind: 'empty' };
  const atoms = parseAmount(input, token.decimals);
  if (atoms === null) {
    return {
      kind: 'invalid',
      message: `Enter an amount with at most ${token.decimals} decimals.`,
    };
  }
  if (atoms === 0n) return { kind: 'zero', message: 'Enter an amount above zero.' };
  if (available === null) return { kind: 'invalid', message: 'Still reading your balance.' };
  if (atoms > available) {
    return {
      kind: 'too_much',
      atoms,
      message: `More than the ${formatAtoms(available, token.decimals)} ${token.symbol} available.`,
    };
  }
  return { kind: 'ok', atoms };
}

/**
 * What Max fills the field with: the whole balance, written so `parseAmount`
 * reads it back to exactly the same atoms. The whole balance is right for
 * both flows — a sponsored send pays no gas from the wallet, and a Kuru
 * withdraw pays gas in MON, never in the token withdrawn. `''` for nothing.
 */
export function maxInput(available: bigint | null, token: Token): string {
  if (available === null || available <= 0n) return '';
  return formatAtoms(available, token.decimals, { group: false });
}

/**
 * The FREE balance of one token in the Kuru account, in atoms, from
 * `/portfolio`'s Kuru section. `available`, never `total`: what resting orders
 * reserve cannot leave, and asking for it reverts on chain, where Monad
 * charges the whole gas limit (gotcha 4). `null` when the section did not
 * answer or the figure does not parse — unknown, not zero (SEN-123).
 */
export function kuruAvailable(balances: readonly BalanceDto[] | null, token: Token): bigint | null {
  if (balances === null) return null;
  const line = balances.find((b) => b.asset === token.symbol);
  if (line === undefined) return 0n;
  return parseAmount(line.available, token.decimals);
}

// ─── Recipient ──────────────────────────────────────────────────────────────

export type RecipientCheck =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ok'; readonly address: Address };

/**
 * A typed recipient, strictly.
 *
 * Mixed case must be a valid EIP-55 checksum: a single mistyped character in a
 * checksummed address is exactly what the checksum exists to catch, so it is
 * refused rather than lower-cased into validity. All-lowercase carries no
 * checksum and is accepted, but the review then shows the checksummed form.
 * The zero address, the token contracts themselves and the user's own wallet
 * are refused: each is either a burn or a transfer that does nothing.
 */
export function checkRecipient(input: string, self: Address | null): RecipientCheck {
  const raw = input.trim();
  if (raw === '') return { kind: 'empty' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { kind: 'invalid', message: 'An address is 0x followed by 40 hex characters.' };
  }
  const lower = raw.slice(2) === raw.slice(2).toLowerCase();
  if (!lower && !isAddress(raw, { strict: true })) {
    return {
      kind: 'invalid',
      message: 'The capitalisation doesn’t match the address checksum. Check it for a typo.',
    };
  }
  const address = getAddress(raw);
  if (/^0x0{40}$/.test(address)) {
    return { kind: 'invalid', message: 'That is the zero address: anything sent there is lost.' };
  }
  if (WITHDRAW_TOKENS.some((token) => isAddressEqual(token.address, address))) {
    return {
      kind: 'invalid',
      message: 'That is a token contract. Tokens sent to it are lost.',
    };
  }
  if (self !== null && isAddressEqual(self, address)) {
    return { kind: 'invalid', message: 'That is your own wallet.' };
  }
  return { kind: 'ok', address };
}

/** What an address holds as code, as `eth_getCode` answers. */
export type CodeKind = 'none' | 'delegated' | 'contract';

/**
 * `eth_getCode` read as what it means for a recipient.
 *
 * An EIP-7702 delegation designator (`0xef0100` + 20-byte address) is an EOA
 * that runs a contract's code: a key still controls it, so it is a person's
 * account, not a contract that may have no way to send tokens back. Privy
 * wallets become exactly that on their first sponsored send.
 */
export function classifyCode(code: string | undefined | null): CodeKind {
  if (code === undefined || code === null || code === '0x' || code === '') return 'none';
  if (/^0xef0100[0-9a-fA-F]{40}$/.test(code)) return 'delegated';
  return 'contract';
}

export type RecipientWarning =
  | { readonly kind: 'agent'; readonly agentName: string }
  | { readonly kind: 'contract' }
  | { readonly kind: 'code_unknown' }
  | { readonly kind: 'agents_unknown' }
  | { readonly kind: 'new' };

export type RecipientFacts = {
  readonly address: Address;
  /** The user's hired agents' wallets; `null` when the list could not be read. */
  readonly agents: readonly { readonly name: string; readonly address: Address }[] | null;
  /** Addresses this phone has sent a withdrawal to before. */
  readonly known: readonly string[];
  /** From `classifyCode`; `null` when the read failed. */
  readonly code: CodeKind | null;
};

/**
 * Everything about a recipient worth a second look, most serious first. Any
 * warning at all turns the review's confirm into a second, explicit step.
 *
 * - `agent`: the address is one of the user's own agents. Sending there is not
 *   a withdrawal — it funds the agent, which may then trade with it.
 * - `contract`: code that is not a delegated EOA. Many contracts cannot move
 *   tokens they receive, so the funds may be stuck for good.
 * - `code_unknown` / `agents_unknown`: a read failed; said rather than
 *   assumed to be fine.
 * - `new`: never sent to from this phone, the case where a pasted address
 *   from the wrong clipboard entry does its damage.
 */
export function recipientWarnings(facts: RecipientFacts): RecipientWarning[] {
  const warnings: RecipientWarning[] = [];
  const agent = facts.agents?.find((a) => isAddressEqual(a.address, facts.address));
  if (agent) warnings.push({ kind: 'agent', agentName: agent.name });
  // Unread is not "not an agent": say so rather than skip the one warning
  // that keeps a withdrawal from quietly funding an agent instead.
  if (facts.agents === null) warnings.push({ kind: 'agents_unknown' });
  if (facts.code === 'contract') warnings.push({ kind: 'contract' });
  if (facts.code === null) warnings.push({ kind: 'code_unknown' });
  const seen = facts.known.some((k) => isAddress(k) && isAddressEqual(k as Address, facts.address));
  // An agent is the user's own and named on screen; "new" would add nothing.
  if (!seen && !agent) warnings.push({ kind: 'new' });
  return warnings;
}

export function warningCopy(warning: RecipientWarning): { title: string; detail: string } {
  switch (warning.kind) {
    case 'agent':
      return {
        title: `This is your agent ${warning.agentName}’s wallet`,
        detail:
          'Sending here funds the agent: it can trade with this money inside its mandate. ' +
          'To take money out of Sente, send to a wallet you control.',
      };
    case 'contract':
      return {
        title: 'This address is a contract',
        detail:
          'Many contracts can’t send tokens back. If it isn’t an exchange deposit address or a ' +
          'wallet you know, the funds may be lost.',
      };
    case 'code_unknown':
      return {
        title: 'Couldn’t check this address',
        detail: 'The chain didn’t answer, so we can’t tell whether it is a contract.',
      };
    case 'agents_unknown':
      return {
        title: 'Couldn’t check your agents',
        detail:
          'Your agents didn’t load, so we can’t tell whether this is one of their wallets. ' +
          'Sending to an agent funds it.',
      };
    case 'new':
      return {
        title: 'You haven’t sent here before',
        detail: 'Compare every character with the address you meant. Transfers can’t be undone.',
      };
  }
}

/**
 * Addresses remembered as "sent to before", newest first, deduplicated,
 * capped so the stored list cannot grow without bound.
 */
export const KNOWN_RECIPIENTS_MAX = 20;

export function rememberRecipient(known: readonly string[], address: Address): string[] {
  const key = address.toLowerCase();
  return [key, ...known.filter((k) => k.toLowerCase() !== key)].slice(0, KNOWN_RECIPIENTS_MAX);
}

/** The stored list, read defensively: anything that is not a list of addresses is no list. */
export function parseKnownRecipients(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is string => typeof v === 'string' && isAddress(v, { strict: false }),
    );
  } catch {
    return [];
  }
}

// ─── Review and results ─────────────────────────────────────────────────────

export function amountLabel(atoms: bigint, token: Token): string {
  return `${formatAtoms(atoms, token.decimals)} ${token.symbol}`;
}

/** The review headline: `You send 12.5 USDC to 0x51c0…c21e`. The full address sits under it. */
export function sendReview(atoms: bigint, token: Token, to: Address): string {
  return `You send ${amountLabel(atoms, token)} to ${shortAddress(getAddress(to))}`;
}

export function kuruReview(atoms: bigint, token: Token): string {
  return `You move ${amountLabel(atoms, token)} from your Kuru account to your wallet`;
}

export type WithdrawResult = {
  readonly tone: 'ok' | 'info' | 'error';
  readonly title: string;
  readonly detail: string;
  /** Settled either way: the sheet can close, the form can clear. */
  readonly final: boolean;
};

/**
 * A sponsored send's outcome, honestly (SEN-127, gotcha 8).
 *
 * Only `included` is success and only `reverted` is failure: both come from
 * the user operation's own flag. Everything else — `pending` from a timeout,
 * `unknown` from an API that lost its record — was signed and sent and may
 * still land, so it is never "failed", which would invite a second send.
 */
export function sendResult(
  status: ConfirmationStatus,
  atoms: bigint,
  token: Token,
  to: Address,
): WithdrawResult {
  const what = amountLabel(atoms, token);
  const where = shortAddress(getAddress(to));
  switch (status) {
    case 'included':
      return {
        tone: 'ok',
        title: `Sent ${what} to ${where}`,
        detail: 'It landed on chain.',
        final: true,
      };
    case 'reverted':
      return {
        tone: 'error',
        title: 'The transfer reverted',
        detail: 'It was included on chain but didn’t execute, so nothing moved.',
        final: false,
      };
    default:
      return {
        tone: 'info',
        title: `Sending ${what} to ${where}`,
        detail:
          'Submitted, not confirmed yet. Don’t send it again: your balance updates once it lands.',
        final: true,
      };
  }
}

/** A `kuru.withdraw` trade's outcome, with the same rule: only terminal answers are verdicts. */
export function kuruResult(
  status: 'completed' | 'failed' | 'expired' | 'pending',
  atoms: bigint,
  token: Token,
): WithdrawResult {
  const what = amountLabel(atoms, token);
  switch (status) {
    case 'completed':
      return {
        tone: 'ok',
        title: `Moved ${what} to your wallet`,
        detail: 'It left your Kuru account.',
        final: true,
      };
    case 'failed':
      return {
        tone: 'error',
        title: 'The withdrawal didn’t go through',
        detail:
          'The trade ended as failed. Pull to refresh and check your Kuru balance before trying again.',
        final: false,
      };
    case 'expired':
      return {
        tone: 'error',
        title: 'The withdrawal expired',
        detail: 'It was never sent. Review it and confirm again.',
        final: false,
      };
    case 'pending':
      return {
        tone: 'info',
        title: `Moving ${what} to your wallet`,
        detail:
          'Signed and sent, not confirmed yet. Don’t send it again: the balances update once it lands.',
        final: true,
      };
  }
}

/**
 * A failed send, in withdraw words. The one refusal worth its own copy is the
 * server's recipient rule (see `EXTERNAL_WITHDRAW_ENABLED`): if a send to an
 * outside address ever reaches it, the user should read that as today's
 * limit, not as a mistake they made. Everything else is `describeSendError`.
 */
export function describeWithdrawError(error: unknown): { title: string; detail: string } {
  if (error instanceof WalletApiError && error.reason === 'send_recipient_not_allowed') {
    return {
      title: 'Sends to other addresses aren’t available yet',
      detail:
        'For now Sente only sends from your wallet to your own wallet or to an agent you hired. ' +
        'Nothing was sent.',
    };
  }
  return describeSendError(error);
}
