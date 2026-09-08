/**
 * Shared viem clients and transaction defaults for Monad.
 *
 * Kept free of React Native imports on purpose so it can also be exercised
 * from plain node (see `scripts/read-block.ts`).
 */
import { createPublicClient, http, type Chain, type PublicClient } from 'viem';
// viem ships both Monad chains — never hand-roll `defineChain` for these, the
// ids, block time and multicall3 deployment are already correct upstream.
// monad = 143 (mainnet), monadTestnet = 10143.
import { monad, monadTestnet } from 'viem/chains';

export { monad, monadTestnet };

export type MonadNetwork = 'mainnet' | 'testnet';

/**
 * Default network. `EXPO_PUBLIC_*` is inlined into the app bundle by Expo, so
 * this is a build-time constant on device and a normal env read under node.
 */
export const MONAD_NETWORK: MonadNetwork =
  process.env.EXPO_PUBLIC_MONAD_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

export const monadChain: Chain = MONAD_NETWORK === 'mainnet' ? monad : monadTestnet;

/** Optional override; falls back to the chain's default public RPC from viem. */
const rpcUrl = process.env.EXPO_PUBLIC_MONAD_RPC_URL || undefined;

export const publicClient: PublicClient = createPublicClient({
  chain: monadChain,
  transport: http(rpcUrl, {
    // Monad blocks are ~400ms; a short batch window costs nothing and cuts
    // request count hard on list screens.
    batch: { wait: 50 },
    retryCount: 2,
  }),
});

/**
 * ---------------------------------------------------------------------------
 * MONAD GAS RULE — read before you write a transaction.
 *
 * Monad charges the sender on the gas LIMIT, not on gas used:
 *
 *     fee = value + gas_bid * gas_limit
 *
 * So an overestimate is money genuinely spent, not merely reserved. viem's
 * default behaviour — call `eth_estimateGas` and submit the result — therefore
 * overspends on every transaction, and estimation on Monad already returns a
 * padded number.
 *
 * Consequently: ALWAYS pass an explicit `gas` on writes. Spread
 * `MONAD_TX_DEFAULTS` for a plain transfer, and for anything heavier measure
 * the real cost once and hard-code that constant next to the call. Do not take
 * an `estimateGas` result and multiply it by a safety factor.
 * ---------------------------------------------------------------------------
 */
export const MONAD_TX_DEFAULTS = {
  /** Native MON transfer. Same 21k floor as Ethereum. */
  gas: 21_000n,
} as const;

/** Measured gas limits for common calls. Extend as contracts land. */
export const MONAD_GAS_LIMITS = {
  nativeTransfer: 21_000n,
  erc20Transfer: 65_000n,
  erc20Approve: 55_000n,
} as const;
