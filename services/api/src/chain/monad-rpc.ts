import { fallback, http, type HttpTransportConfig, type Transport } from 'viem';

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
 */
export function monadReadTransport(
  configured: string | undefined,
  options: HttpTransportConfig = {},
): Transport {
  const urls = monadRpcUrls(configured);
  if (urls.length === 1) return http(urls[0], options);
  return fallback(
    urls.map((url) => http(url, options)),
    { rank: false },
  );
}
