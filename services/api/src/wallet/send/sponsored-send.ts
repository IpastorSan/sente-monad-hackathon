/**
 * ---------------------------------------------------------------------------
 * A PRIVY-SPONSORED SEND FROM THE USER'S OWN WALLET (SEN-42)
 *
 * The user's wallet is a Privy server wallet whose owner key lives on the phone
 * (SEN-40), so this process can compose a send and can never authorise one.
 * Everything here is composition: the exact Privy RPC body, the exact
 * authorization payload the phone signs, and the reading of what comes back.
 * Nothing in this file reaches the network.
 *
 * ## The body is a contract, not an implementation detail
 *
 * The phone REBUILDS this body from the intent it is approving and refuses to
 * sign anything that differs (`apps/mobile/src/wallet/send.ts`). So every
 * choice below is mirrored there, byte for byte:
 *
 *   {
 *     method: 'eth_sendTransaction',
 *     caip2:  'eip155:10143',
 *     sponsor: true,
 *     params: { transaction: { to, data | value, chain_id: 10143 } },
 *   }
 *
 * - `to` is CHECKSUMMED. Privy compares `to` against a policy case-sensitively
 *   (`agents/privy/agent-wallet.ts`), and the signature covers the bytes either
 *   way, so one casing has to be the canonical one.
 * - amounts are `0x` hex, never decimal strings: Privy rejects those outright
 *   (`Invalid input: must start with "0x"`).
 * - an ERC-20 transfer carries `data` and NO `value`; native MON carries
 *   `value` and NO `data`. An absent key and a zero are different bytes.
 * - `chain_id` is set as well as `caip2`. Both were accepted live (SEN-39 check
 *   6, run 2), and the redundancy costs nothing.
 *
 * ## What comes back is a USER OPERATION hash (CLAUDE.md gotcha 8)
 *
 * Measured live on 2026-09-24: a sponsored send answers with `hash: ""`,
 * `user_operation_hash: 0x…` and a `transaction_id`. Privy routes sponsored
 * sends through a bundler and EIP-7702-delegates the wallet on the first one, so
 * the thing that can fail is the USER OPERATION, inside a transaction that
 * reports success. {@link readSendResponse} therefore keeps the two hashes
 * apart and never lets an empty `hash` masquerade as a result.
 * ---------------------------------------------------------------------------
 */

import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  isHash,
  type Address,
  type Hex,
} from 'viem';
import { KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';

import type { BalanceToken } from '../balances/token-balances.ts';

/** Monad testnet. The one chain this app sends on. */
export const SEND_CHAIN_ID = 10143;

/** The CAIP-2 name of that chain, as Privy's RPC wants it. */
export const SEND_CAIP2 = `eip155:${SEND_CHAIN_ID}` as const;

/**
 * What the user's wallet may send.
 *
 * Kuru's test assets (MON included — the Kuru table calls native MON by the
 * zero address) plus Agora's AUSD, which is Perpl's collateral. Mirrors
 * `apps/mobile/src/agents/fund.ts#FUNDING_TOKENS`, and both read the addresses
 * out of `@sente/venues` rather than keeping a second copy: a drifted constant
 * is how a transfer lands in a token nobody holds.
 */
export const SENDABLE_TOKENS: readonly BalanceToken[] = [
  ...Object.values(KURU_TESTNET_TOKENS),
  {
    symbol: 'AUSD',
    address: PERPL_TESTNET_CONTRACTS.collateral,
    decimals: PERPL_COLLATERAL_DECIMALS,
  },
];

/** Built once: every sendable token by lower-cased address. */
const SENDABLE_BY_ADDRESS = new Map(
  SENDABLE_TOKENS.map((token) => [token.address.toLowerCase(), token] as const),
);

/**
 * The sendable token at `address`, or undefined — the allowlist, as a lookup.
 *
 * Keyed on the lower-cased address rather than checksummed, so an unparseable
 * string is simply a miss: this is reached with whatever a client sent.
 */
export function sendableToken(address: string): BalanceToken | undefined {
  return SENDABLE_BY_ADDRESS.get(address.trim().toLowerCase());
}

export function isNativeToken(token: BalanceToken): boolean {
  return isAddressEqual(token.address, NATIVE_TOKEN);
}

/** Privy's RPC endpoint for one wallet. Part of the signed bytes. */
export function walletRpcPath(walletId: string): string {
  return `/v1/wallets/${walletId}/rpc`;
}

/** A hex quantity as Privy takes it: `0x`, lowercase, unpadded. */
function hexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

/**
 * The `params.transaction` of one transfer: an ERC-20 `transfer` call, or a
 * native MON value send.
 *
 * `gas`, `nonce` and the fees are deliberately absent. A sponsored send is
 * built into a UserOperation by Privy's bundler, which sizes and prices it;
 * naming our own numbers here would be guessing on somebody else's behalf, and
 * on Monad an overestimate is money genuinely spent (gotcha 4) — theirs in this
 * case, but a refusal all the same.
 */
export function sponsoredTransferTransaction(
  token: BalanceToken,
  recipient: Address,
  atoms: bigint,
): Record<string, unknown> {
  if (atoms <= 0n) throw new RangeError('a send amount must be above zero');
  const to = getAddress(recipient);
  if (isNativeToken(token)) {
    return { to, value: hexQuantity(atoms), chain_id: SEND_CHAIN_ID };
  }
  return {
    to: getAddress(token.address),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, atoms] }),
    chain_id: SEND_CHAIN_ID,
  };
}

/** The whole Privy RPC body for a sponsored send. See the module header. */
export function sponsoredSendBody(transaction: Record<string, unknown>): Record<string, unknown> {
  return {
    method: 'eth_sendTransaction',
    caip2: SEND_CAIP2,
    // The point of the phase: the user never needs MON to move USDC.
    sponsor: true,
    params: { transaction },
  };
}

/**
 * What Privy answered, read without wishful thinking.
 *
 * `hash` is an empty string on a sponsored send, and an empty string is not a
 * hash — it is the field Privy fills for a plain broadcast. Keeping the two
 * apart is what stops a confirmation view from polling a transaction receipt
 * for a user-operation hash, which is the bug this issue found in the SEN-39
 * probe (check 6r) and never gets an answer.
 */
export interface SponsoredSendOutcome {
  /** Present when Privy bundled it: the hash to read a USER OPERATION receipt for. */
  userOpHash?: Hex;
  /** Present only when Privy broadcast a plain transaction (an unsponsored send). */
  transactionHash?: Hex;
  /** Privy's own id for the attempt. Useful in their dashboard; not a chain hash. */
  transactionId?: string;
}

/** A 32-byte hash, or nothing. `hash: ""` on a sponsored send is nothing. */
function hash32(value: unknown): Hex | undefined {
  return typeof value === 'string' && isHash(value) ? value : undefined;
}

export function readSendResponse(response: unknown): SponsoredSendOutcome {
  const data = (response as { data?: Record<string, unknown> } | null)?.data ?? {};
  const userOpHash = hash32(data['user_operation_hash']);
  const transactionHash = hash32(data['hash']);
  const transactionId =
    typeof data['transaction_id'] === 'string' ? data['transaction_id'] : undefined;
  return {
    ...(userOpHash ? { userOpHash } : {}),
    ...(transactionHash ? { transactionHash } : {}),
    ...(transactionId ? { transactionId } : {}),
  };
}
