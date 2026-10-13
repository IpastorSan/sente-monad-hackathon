import { fallback, http, type Transport } from 'viem';

/** Monad's own public testnet RPC (about 15 requests a second, shared). */
export const MONAD_TESTNET_PUBLIC_RPC = 'https://testnet-rpc.monad.xyz';

/** The RPCs a read tries in order: `MONAD_TESTNET_RPC_URL`, then the public one. */
export function monadRpcUrls(configured: string | undefined): string[] {
  const url = configured?.trim();
  return url && url !== MONAD_TESTNET_PUBLIC_RPC
    ? [url, MONAD_TESTNET_PUBLIC_RPC]
    : [MONAD_TESTNET_PUBLIC_RPC];
}

/**
 * A read transport on `MONAD_TESTNET_RPC_URL` (a dedicated endpoint such as
 * Alchemy's) that moves on to Monad's public RPC when it fails or throttles.
 * Unset, it is the public RPC alone. On 2026-10-12 the public RPC alone failed
 * the trade ticket's Perpl account read after four retries.
 *
 * Retries belong to the fallback, not to each endpoint (SEN-203). viem's
 * `http` keeps its own `retryCount` over the 0 that `fallback` hands it, so
 * an inner transport with retries made a hung dedicated RPC cost a timeout
 * per retry before the public one was tried. Each endpoint here gets one
 * attempt with a short timeout, and the fallback retries the whole chain.
 */
export const MONAD_RPC_TIMEOUT_MS = 8_000;

export interface MonadReadOptions {
  /** Retries of the whole read (every endpoint in turn), after the first try. */
  retryCount?: number;
  /** Base delay between retries, in ms (viem backs off exponentially). */
  retryDelay?: number;
  /** One endpoint's timeout for one request, in ms. */
  timeout?: number;
}

export function monadReadTransport(
  configured: string | undefined,
  options: MonadReadOptions = {},
): Transport {
  const { retryCount, retryDelay, timeout = MONAD_RPC_TIMEOUT_MS } = options;
  const urls = monadRpcUrls(configured);
  if (urls.length === 1) return http(urls[0], { retryCount, retryDelay, timeout });
  return fallback(
    urls.map((url) => http(url, { retryCount: 0, timeout })),
    { rank: false, retryCount, retryDelay },
  );
}
