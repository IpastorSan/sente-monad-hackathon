/**
 * ---------------------------------------------------------------------------
 * THE CONFIRMATION RACE
 *
 * Two sources answer the same question and they are NOT redundant:
 *
 *   BUNDLER   `eth_getUserOperationReceipt` — the EntryPoint's own
 *             `UserOperationEvent`: per-operation success/failure, the real
 *             transaction hash, the block. Authoritative, richest, and usually
 *             first.
 *   OUR API   `GET /wallet/operations/:hash` — always available. It survives a
 *             bundler indexer lagging, and it is the only source at all when no
 *             public bundler URL is configured in the app bundle.
 *
 * So poll both every tick and take whichever answers first.
 *
 * CADENCE: 300ms, which is Monad's block time. The Charms version of this used
 * 200ms because Base ships flash blocks at that rate; carrying that number over
 * would just mean a third more requests for no earlier answer. It then backs
 * off, because a UserOperation that has not landed in a few seconds is not
 * going to land in the next 300ms either.
 *
 * ONLY `included` AND `reverted` ARE VERDICTS (SEN-127). A 404, a 5xx, a
 * dropped connection, a bundler that has not indexed the operation yet: none of
 * them says the transfer failed, and telling a user a live transfer failed
 * invites them to send it again. Those map to `unknown` or `null` and the race
 * keeps polling.
 *
 * A TIMEOUT IS NOT A FAILURE. An operation that has not surfaced may still land
 * minutes later, so this returns `pending` rather than throwing — the caller
 * reconciles on the next refresh.
 * ---------------------------------------------------------------------------
 */
import type { Hash } from 'viem';
import type { BundlerClient } from 'viem/account-abstraction';

import { WalletApiError, type WalletApi } from './api.ts';

/** Monad's block time. Not Base's 200ms flash-block cadence. */
export const MONAD_BLOCK_MS = 300;

export type ConfirmationStatus = 'pending' | 'included' | 'reverted' | 'unknown';

export type ConfirmationResult = {
  userOpHash: Hash;
  status: ConfirmationStatus;
  transactionHash?: Hash;
  blockNumber?: bigint;
  actualGasCost?: bigint;
  /** Which source answered. Useful in logs when one side is lagging. */
  source: 'bundler' | 'api' | 'timeout';
};

/** What the race needs from each source. `null` means "no answer yet". */
export type ConfirmationSources = {
  bundler?: (userOpHash: Hash) => Promise<Omit<ConfirmationResult, 'source' | 'userOpHash'> | null>;
  api: (userOpHash: Hash) => Promise<Omit<ConfirmationResult, 'source' | 'userOpHash'> | null>;
};

export type WaitOptions = {
  timeoutMs?: number;
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Poll delay for a given attempt.
 *
 * Aligned to Monad's 300ms blocks for the first ~3 seconds, then backing off:
 * beyond that the operation is queued behind congestion, not about to appear.
 */
export function confirmationDelay(attempt: number): number {
  if (attempt === 0) return 0;
  if (attempt <= 10) return MONAD_BLOCK_MS;
  if (attempt <= 20) return 750;
  return 1_500;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForUserOperation(
  userOpHash: Hash,
  sources: ConfirmationSources,
  { timeoutMs = 90_000, sleep = defaultSleep }: WaitOptions = {},
): Promise<ConfirmationResult> {
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const delay = confirmationDelay(attempt);
    if (delay > 0) {
      await sleep(delay);
    }

    // Both every tick. `allSettled`, because one source being down must not
    // cancel the other — that is the entire reason there are two.
    const [bundler, api] = await Promise.allSettled([
      sources.bundler ? sources.bundler(userOpHash) : Promise.resolve(null),
      sources.api(userOpHash),
    ]);

    // The bundler wins ties: it reports the UserOperation's OWN success flag.
    // A UserOperation can revert inside a bundle transaction that itself
    // succeeded, so a status view derived from anything coarser would call a
    // reverted operation confirmed.
    // Both sides go through `isSettled`: `unknown` from either one means "no
    // record", not a verdict (SEN-127).
    if (bundler.status === 'fulfilled' && bundler.value && isSettled(bundler.value.status)) {
      return { userOpHash, ...bundler.value, source: 'bundler' };
    }
    if (api.status === 'fulfilled' && api.value && isSettled(api.value.status)) {
      return { userOpHash, ...api.value, source: 'api' };
    }
  }

  return { userOpHash, status: 'pending', source: 'timeout' };
}

function isSettled(status: ConfirmationStatus): boolean {
  return status === 'included' || status === 'reverted';
}

/**
 * Our own status view as a confirmation source (`GET /wallet/operations/:hash`).
 *
 * A 404 means "we have no record of this hash" and maps to `unknown`; every
 * other failure maps to `null`. NEITHER settles the race (SEN-127): the status
 * view is in memory, so an API restart mid-poll answers 404 for an operation
 * that may be about to land. `unknown` differs from `null` only in what it
 * tells a log; it is not a verdict and never becomes `reverted`. Shared by the
 * Kernel path (`useSmartAccount.ts`) and the sponsored send (`send.ts`) so both
 * read the same answer the same way.
 */
export async function readApiStatus(
  api: WalletApi,
  userOpHash: Hash,
): Promise<Omit<ConfirmationResult, 'source' | 'userOpHash'> | null> {
  try {
    const status = await api.status(userOpHash);
    return {
      status: status.status,
      ...(status.transactionHash ? { transactionHash: status.transactionHash } : {}),
      ...(status.blockNumber !== undefined ? { blockNumber: BigInt(status.blockNumber) } : {}),
      ...(status.actualGasCost !== undefined
        ? { actualGasCost: BigInt(status.actualGasCost) }
        : {}),
    };
  } catch (error) {
    if (error instanceof WalletApiError && error.status === 404) {
      return { status: 'unknown' };
    }
    return null;
  }
}

/** The one bundler call the race makes; viem's `BundlerClient` satisfies it. */
export type BundlerReceiptReader = Pick<BundlerClient, 'getUserOperationReceipt'>;

/**
 * The bundler as a confirmation source (`eth_getUserOperationReceipt`).
 *
 * Lives here rather than in `useSmartAccount.ts` so plain node can test it
 * (SEN-127): with `readApiStatus` it is one of the only two places the phone
 * turns a raw answer into `included` or `reverted`.
 */
export async function readBundlerReceipt(
  bundler: BundlerReceiptReader,
  userOpHash: Hash,
): Promise<Omit<ConfirmationResult, 'source' | 'userOpHash'> | null> {
  try {
    const receipt = await bundler.getUserOperationReceipt({ hash: userOpHash });
    return {
      // `receipt.success` is the UserOperation's OWN flag (gotcha 8). A bundle
      // transaction can succeed while the operation inside it reverted, so the
      // carrying transaction's `receipt.receipt.status` must never decide this.
      status: receipt.success ? 'included' : 'reverted',
      transactionHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber,
      actualGasCost: receipt.actualGasCost,
    };
  } catch {
    // viem throws `UserOperationReceiptNotFoundError` while the operation is
    // still in the mempool, and rethrows any transport error. Neither is a
    // verdict.
    return null;
  }
}
