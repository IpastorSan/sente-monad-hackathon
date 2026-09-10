/**
 * Kuru Spot V2 on Monad testnet (10143) — every address the adapter touches.
 *
 * This is "Set C" in docs/kuru.md: the Spot V2 deployment published at
 * `kuru-testnet-docs.mintlify.site/deployments/testnet`, and the only one the
 * `@toxicflow-labs/ts-sdk` ABIs match. The V1 addresses in `docs.kuru.io`
 * (Router / MarginAccount) are a different contract generation — pairing them
 * with this SDK is a category error, not a version skew.
 *
 * Every contract here was confirmed with `eth_getCode` on testnet and is absent
 * on mainnet 143, so a mainnet build must not reuse this table.
 */
import type { Address } from 'viem';

export const KURU_TESTNET_CHAIN_ID = 10143;

export const KURU_TESTNET_CONTRACTS = {
  /** Shared custody, account IDs and signer permissions. ERC-1967 proxy. */
  accountCore: '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22',
  /** Verified-market registry. ERC-1967 proxy. */
  spotRouter: '0xba24a1042701f06e8F7edCF04389260D1Fa4c697',
  /** Implementation behind every market proxy. Never call it directly. */
  orderBookImplementation: '0xE20f57e673d7F254279c19270862A3d1E6F5B0d4',
  /** EIP-7702 delegate for Relay-sponsored trading EOAs. Unused by this adapter. */
  kuruTradingWallet: '0xc7f2a9761276F7050D6561d2FDC51abC993F45E9',
  /** Permissionless test-token faucet. Not a proxy. */
  testnetTokenFaucet: '0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9',
} as const satisfies Record<string, Address>;

/**
 * The three testnet API surfaces. `exchange.kuru.io` is mainnet-only and its
 * Binance-style routes 404 here.
 *
 * - Data Source: finalized catalogs, candles, trades, `/api/v1/...`.
 * - Exchange Gateway: current projected book and user snapshots. Read-only —
 *   there is no order-entry route on it.
 * - Relay: gas sponsorship for EIP-7702 trading EOAs. Not used for a Kernel
 *   account, which calls the OrderBook itself (see `adapter.ts`).
 */
export const KURU_TESTNET_API = {
  dataSource: 'https://api.testnet.kuru.io',
  gateway: 'https://gateway.testnet.kuru.io',
  relay: 'https://relay.testnet.kuru.io',
} as const;

/** AccountCore and the market ABIs use the zero address for native MON. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as const satisfies Address;

export type KuruToken = {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
};

/**
 * Kuru's own test assets. Kuru Testnet USDC is the quote asset of every
 * market — it is NOT Agora's AUSD, which is the Perpl leg's collateral.
 */
export const KURU_TESTNET_TOKENS = {
  MON: { symbol: 'MON', address: NATIVE_TOKEN, decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E', decimals: 6 },
  // Kuru's deployment page prints this with a broken EIP-55 checksum
  // (`…380aaf8`), which viem rejects at call time. This is the valid form.
  WETH: { symbol: 'WETH', address: '0x8B6C5fafeF85B030bB1e71ae7ac085cC2380aAf8', decimals: 18 },
  cbBTC: { symbol: 'cbBTC', address: '0xef2a20a161ac9ed1117d721336226b6399F15b4D', decimals: 8 },
  // The deployment page calls this "XAUt0"; the token's own `symbol()` and the
  // Data Source catalog both say "XAUt". The chain wins.
  XAUt: { symbol: 'XAUt', address: '0xee1Dce135a9aB598bca8CF3a28bDEF6892100740', decimals: 6 },
} as const satisfies Record<string, KuruToken>;

export type KuruMarketConfig = {
  /** Canonical Sente symbol, `BASE-QUOTE`. */
  readonly symbol: string;
  /** Kuru's symbol, as the Gateway's `?symbol=` expects it. */
  readonly venueSymbol: string;
  /** The market's own OrderBook proxy. */
  readonly address: Address;
  readonly base: KuruToken;
  readonly quote: KuruToken;
  /**
   * Book price units per 1 quote-per-base. Book prices are `uint32`, so this
   * is also what caps a market's price range.
   */
  readonly pricePrecision: bigint;
  /** Book size units per 1 base. */
  readonly sizePrecision: bigint;
  /** Prices must be a multiple of this, in book price units. */
  readonly tickSize: bigint;
};

/**
 * The four canonical markets. The precision columns are the published
 * deployment values and were re-read from `getMarketParams()` on chain; the
 * adapter still reads them live before it signs anything, so a redeploy
 * cannot make it mis-scale an order.
 */
export const KURU_TESTNET_MARKETS: readonly KuruMarketConfig[] = [
  {
    symbol: 'MON-USDC',
    venueSymbol: 'MONUSDC',
    address: '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61',
    base: KURU_TESTNET_TOKENS.MON,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 1_000_000n,
    sizePrecision: 100_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'WETH-USDC',
    venueSymbol: 'WETHUSDC',
    address: '0xa9C2936656a7D2143720BcD91Ba8506200B7CbE7',
    base: KURU_TESTNET_TOKENS.WETH,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 10_000_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'cbBTC-USDC',
    venueSymbol: 'CBBTCUSDC',
    address: '0x5BDEA6F9F9abA34F4EcB9B865646A792b835ef7f',
    base: KURU_TESTNET_TOKENS.cbBTC,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 100_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'XAUt-USDC',
    venueSymbol: 'XAUTUSDC',
    address: '0x0B4dD2A7b09d5c5401149fFe51301Cc589017343',
    base: KURU_TESTNET_TOKENS.XAUt,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 1_000_000n,
    tickSize: 1n,
  },
];

/**
 * Faucet facts, read off the contract's own getters (it is not a proxy, so the
 * dispatch table is the real one) and then exercised on chain.
 *
 * One `claim()` pays 10,000 USDC, 1 WETH, 0.1 cbBTC and 1 XAUt to the caller
 * (observed: tx 0xe0e063e9055614f27e253ab7e41f737c00f0800a43453079fb6fe2ef26c5b314).
 * The cooldown is PER ADDRESS — `nextClaimAt(address)` — unlike Agora's AUSD
 * faucet, whose 60 s window is global and shared with every other team.
 */
export const KURU_FAUCET = {
  address: KURU_TESTNET_CONTRACTS.testnetTokenFaucet,
  /** `claim()`. Pays `msg.sender`, so a Kernel account claims for itself. */
  claimSelector: '0x4e71d92d',
  /** `COOLDOWN()` = 43,200 s = 12 h between claims by the same address. */
  cooldownSeconds: 43_200,
  /** Measured: 261,237 gas from a fresh address. */
  claimGas: 270_000n,
} as const;

/**
 * Gas for each Kuru call, measured with `eth_estimateGas` from an EOA on
 * Monad testnet on 2026-09-10 (`scripts/kuru-live.ts`). Monad charges on the
 * limit, so size a Kernel batch's `callGasLimit` as the sum of its legs plus
 * the account's own overhead — measure, don't round up (CLAUDE.md gotcha 4).
 *
 * These are one market's numbers at one book depth. Placement cost grows with
 * the number of price levels an order crosses, and an account's first deposit
 * pays for its registration.
 */
export const KURU_MEASURED_GAS = {
  erc20Approve: 52_089n,
  /** First deposit: includes registering the account in AccountCore. */
  firstDeposit: 252_059n,
  /** GTC order that rests without crossing. */
  placeResting: 404_204n,
  /** IOC order sweeping one price level. */
  placeTakingOneLevel: 425_430n,
  cancelOne: 242_923n,
  /** claim + approve + deposit + place as one Kernel `execute` (simulated). */
  kernelOnboardAndPlace: 841_763n,
} as const;
