/**
 * Set C's TestnetTokenFaucet, for `scripts/kuru-faucet.ts` (SEN-189): which
 * key claims, and the two calls a claim needs. Pure, so the argument parsing is
 * tested under plain node; the script does the I/O.
 *
 * Only Set C has a faucet, and it pays only Set C's tokens (10,000 USDC, 1
 * WETH, 0.1 cbBTC, 1 XAUt per claim; 12 h cooldown per address). Set D's USDC
 * is minted by Kuru's owner and has none.
 */
import type { Hex } from 'viem';

import { KURU_FAUCET } from './constants.ts';

/** The keys a claim may be made with, by the `.env` variable that holds each. */
export const KURU_FAUCET_KEYS = {
  treasury: 'TREASURY_PRIVATE_KEY',
  starter: 'STARTER_DRIP_PRIVATE_KEY',
} as const;

export type KuruFaucetKey = keyof typeof KURU_FAUCET_KEYS;

export type KuruFaucetArgs = {
  /** Which key claims. */
  readonly key: KuruFaucetKey;
  /** The `.env` variable that holds it. */
  readonly envVar: (typeof KURU_FAUCET_KEYS)[KuruFaucetKey];
  /** Read the cooldown and balances, send nothing. */
  readonly dryRun: boolean;
  /** RPC override; Monad's public testnet endpoint when absent. */
  readonly rpcUrl?: string;
};

/**
 * `--key treasury|starter` (default treasury), `--dry-run`, `--rpc <url>`.
 * Anything else throws, so a typo cannot claim with the wrong key.
 */
export function parseKuruFaucetArgs(argv: readonly string[]): KuruFaucetArgs {
  let key: KuruFaucetKey = 'treasury';
  let dryRun = false;
  let rpcUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--key' || arg === '--rpc') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--rpc') {
        rpcUrl = value;
      } else if (value === 'treasury' || value === 'starter') {
        key = value;
      } else {
        throw new Error(`--key must be treasury or starter, got ${value}`);
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { key, envVar: KURU_FAUCET_KEYS[key], dryRun, ...(rpcUrl ? { rpcUrl } : {}) };
}

/** `claim()`: pays `msg.sender`. */
export function kuruFaucetClaimCall(): { to: Hex; data: Hex; gas: bigint } {
  return { to: KURU_FAUCET.address, data: KURU_FAUCET.claimSelector, gas: KURU_FAUCET.claimGas };
}

/** `nextClaimAt(address)` as a function ABI, for `readContract`. */
export const KURU_FAUCET_NEXT_CLAIM_ABI = [
  {
    type: 'function',
    name: 'nextClaimAt',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Seconds until `nextClaimAt` allows a claim; `0` when one may be made now. */
export function kuruFaucetWaitSeconds(nextClaimAt: bigint, nowSeconds: number): number {
  const wait = nextClaimAt - BigInt(Math.floor(nowSeconds));
  return wait > 0n ? Number(wait) : 0;
}
