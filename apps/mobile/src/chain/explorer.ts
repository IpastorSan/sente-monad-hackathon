/**
 * Links to the block explorer viem names for the app's chain
 * (`monadChain.blockExplorers`), so a hash on screen can be opened.
 */
import { monadChain } from './client';

/** The explorer page of a transaction, or `null` when the chain names no explorer. */
export function txUrl(hash: string): string | null {
  const base = monadChain.blockExplorers?.default.url;
  if (!base || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return `${base.replace(/\/+$/, '')}/tx/${hash}`;
}

/** The explorer page of an address, or `null` when the chain names no explorer. */
export function addressUrl(address: string): string | null {
  const base = monadChain.blockExplorers?.default.url;
  if (!base || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `${base.replace(/\/+$/, '')}/address/${address}`;
}
