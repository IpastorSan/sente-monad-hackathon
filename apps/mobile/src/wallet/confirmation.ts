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
 * A TIMEOUT IS NOT A FAILURE. An operation that has not surfaced may still land
 * minutes later, so this returns `pending` rather than throwing — the caller
 * reconciles on the next refresh.
 * ---------------------------------------------------------------------------
 */
import type { Hash } from 'viem';

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
    if (bundler.status === 'fulfilled' && bundler.value && bundler.value.status !== 'pending') {
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
 * A 404 is a real answer — "we have no record of this hash" — and settles the
 * race as `unknown`; every other failure is transient and must NOT settle it,
 * which is the difference between a network blip and a verdict. Shared by the
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
