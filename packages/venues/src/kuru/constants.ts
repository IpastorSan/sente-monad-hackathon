/**
 * Kuru Spot V2 on Monad testnet (10143) — every address the adapter touches.
 *
 * THIS TABLE IS THE SOURCE OF TRUTH, re-established 2026-10-09 (SEN-185). It is
 * Kuru's account-id deployment ("Set D" in docs/kuru.md): the one published at
 * `kuru-testnet-docs.mintlify.site/deployments/testnet` (markets created
 * 2026-09-25, implementations upgraded 2026-09-29 at block 66,669,731) and the
 * only one the Data Source catalog still lists. Every address was read back
 * from the chain on 2026-10-09, not just copied: each OrderBook's
 * `accountCore()`, `baseToken()`, `quoteToken()` and `getMarketParams()`; the
 * ERC-1967 implementation slot of every proxy; `AccountCore.spotRouterAddress()`,
 * `.verifiedSpotOrderBook()` and `.supportedSpotTokens()`; `SpotRouter
 * .spotOrderBookImplementation()` and `.verifiedSpotMarket()`.
 *
 * It needs `@toxicflow-labs/ts-sdk` 0.3.x: this AccountCore keys custody by a
 * numeric account id (`deposit(rootOwner, …)`, `withdraw(rootAccountId, …,
 * recipient)`, `getBalance(accountId, …)`), and the 0.0.x ABIs' address-keyed
 * `deposit(token, amount)` / `withdraw(token, amount)` do not exist on it.
 *
 * The previous deployment ("Set C") is kept below as
 * {@link KURU_RETIRED_DEPLOYMENT}: its contracts still answer on chain, but the
 * catalog no longer lists its books and its tokens are not the ones these trade.
 *
 * Every contract here is absent on mainnet 143, so a mainnet build must not
 * reuse this table.
 */
import type { Address } from 'viem';

export const KURU_TESTNET_CHAIN_ID = 10143;

export const KURU_TESTNET_CONTRACTS = {
  /** Custody, numeric account ids, signer permissions. ERC-1967 proxy. */
  accountCore: '0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038',
  /** Market registry; every OrderBook's `owner()`. ERC-1967 proxy. */
  spotRouter: '0xf75A7529b83941e001d7D9bc113A73C92112947E',
  /** Implementation behind every market proxy. Never call it directly. */
  orderBookImplementation: '0xa4171E141A3Cf7801d7f06C126284aC0a509e6a9',
  /** Global withdrawal budget AccountCore checks every `withdraw` against. ERC-1967 proxy. */
  withdrawalLimiter: '0x6d9599d6B9A5Cf601C2cdBc43fF170462B256fe0',
  /** EIP-7702 delegate for Relay-sponsored trading EOAs. Unused by this adapter. */
  kuruTradingWallet: '0x43F4BCA50dE3bbcB0A297227fA61Cf3bf2dE0dE1',
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
 * Kuru's own test assets, as each token's `symbol()` and `decimals()` answered
 * on 2026-10-09. Kuru Test USDC is the quote asset of every market — it is NOT
 * Agora's AUSD, which is the Perpl leg's collateral, and it is NOT the Set-C
 * USDC either. AccountCore also enables LINK for spot, but no market trades
 * it, so it is left out.
 *
 * Admin-mintable, and Kuru deployed **no public faucet** for them: test funds
 * come from Kuru on request (the deployment page says so).
 */
export const KURU_TESTNET_TOKENS = {
  MON: { symbol: 'MON', address: NATIVE_TOKEN, decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1', decimals: 6 },
  WETH: { symbol: 'WETH', address: '0x63c84e18184021c6CcE5ea57d0c3Ec0E65f3b303', decimals: 18 },
  WBTC: { symbol: 'WBTC', address: '0x7cDC77B348a2E101C766aD290367f3c5F287af18', decimals: 8 },
  XAUT: { symbol: 'XAUT', address: '0x7553b18A8c8400a1b7746C1F5b4f453D57555838', decimals: 6 },
  USDT: { symbol: 'USDT', address: '0xF7d4179FC134D7Cb6BA3D26B2fb556Ff8903B666', decimals: 6 },
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
 * The five markets, as `getMarketParams()` answered on 2026-10-09. Common to
 * all five: `minQuoteNotional` 10 USDC, `maxQuoteNotional` 5,000,000 USDC,
 * taker fee 7,000 pps (0.07%), maker fee 4,000 pps (0.04%), out of 10^7. The
 * adapter still reads the params live before it signs anything and refuses a
 * market whose precisions differ from these, so a redeploy cannot make it
 * mis-scale an order.
 *
 * MON-USDC's `sizePrecision` is 10^6 here, not Set C's 10^8.
 */
export const KURU_TESTNET_MARKETS: readonly KuruMarketConfig[] = [
  {
    symbol: 'MON-USDC',
    venueSymbol: 'MONUSDC',
    address: '0x26cd68436B6A4AEB3ec52abC20A4d121f8B4BAc9',
    base: KURU_TESTNET_TOKENS.MON,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 1_000_000n,
    sizePrecision: 1_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'WETH-USDC',
    venueSymbol: 'WETHUSDC',
    address: '0x9d187971B64505Ac81f12c5FD2ac9c5247Ec62F3',
    base: KURU_TESTNET_TOKENS.WETH,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 10_000_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'WBTC-USDC',
    venueSymbol: 'WBTCUSDC',
    address: '0x8661cB7c5f4f8ae3ee116B63Aa5a23c69110e357',
    base: KURU_TESTNET_TOKENS.WBTC,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 100_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'XAUT-USDC',
    venueSymbol: 'XAUTUSDC',
    address: '0x0E2A5D9378fB61B8eC100Bd770c449F6fdD3e4d6',
    base: KURU_TESTNET_TOKENS.XAUT,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 100n,
    sizePrecision: 1_000_000n,
    tickSize: 1n,
  },
  {
    symbol: 'USDT-USDC',
    venueSymbol: 'USDTUSDC',
    address: '0x4A0888C502e64AEAE11115508Ec0955c70293dba',
    base: KURU_TESTNET_TOKENS.USDT,
    quote: KURU_TESTNET_TOKENS.USDC,
    pricePrecision: 1_000_000n,
    sizePrecision: 1_000_000n,
    tickSize: 1n,
  },
];

/**
 * THE PREVIOUS DEPLOYMENT ("Set C", listed 2026-09-10 to 2026-09-25). Kept
 * because an agent's live Privy policy and stored mandate may still name these
 * addresses until it is amended (CLAUDE.md gotcha 13), and anything that reads
 * history — fills, receipts, a user's old AccountCore balance — meets them.
 * Nothing new may be signed against them: the Data Source no longer lists the
 * books, and their tokens are not the ones the current books trade.
 *
 * `successor` is the current market a retired book's mandate entry moves to on
 * an amend, and the current token a retired token's deposit cap moves to.
 * cbBTC has no cbBTC successor: Kuru replaced that market with WBTC-USDC.
 */
export const KURU_RETIRED_DEPLOYMENT = {
  retiredOn: '2026-09-25',
  contracts: {
    accountCore: '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22',
    spotRouter: '0xba24a1042701f06e8F7edCF04389260D1Fa4c697',
    orderBookImplementation: '0xE20f57e673d7F254279c19270862A3d1E6F5B0d4',
    kuruTradingWallet: '0xc7f2a9761276F7050D6561d2FDC51abC993F45E9',
    /** Pays only the retired tokens below; the current deployment has no faucet. */
    testnetTokenFaucet: '0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9',
  },
  tokens: [
    { symbol: 'USDC', address: '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E', successor: 'USDC' },
    { symbol: 'WETH', address: '0x8B6C5fafeF85B030bB1e71ae7ac085cC2380aAf8', successor: 'WETH' },
    { symbol: 'cbBTC', address: '0xef2a20a161ac9ed1117d721336226b6399F15b4D', successor: 'WBTC' },
    { symbol: 'XAUt', address: '0xee1Dce135a9aB598bca8CF3a28bDEF6892100740', successor: 'XAUT' },
  ],
  markets: [
    {
      symbol: 'MON-USDC',
      address: '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61',
      successor: 'MON-USDC',
    },
    {
      symbol: 'WETH-USDC',
      address: '0xa9C2936656a7D2143720BcD91Ba8506200B7CbE7',
      successor: 'WETH-USDC',
    },
    {
      symbol: 'cbBTC-USDC',
      address: '0x5BDEA6F9F9abA34F4EcB9B865646A792b835ef7f',
      successor: 'WBTC-USDC',
    },
    {
      symbol: 'XAUt-USDC',
      address: '0x0B4dD2A7b09d5c5401149fFe51301Cc589017343',
      successor: 'XAUT-USDC',
    },
  ],
} as const satisfies {
  readonly retiredOn: string;
  readonly contracts: Record<string, Address>;
  readonly tokens: readonly {
    symbol: string;
    address: Address;
    successor: keyof typeof KURU_TESTNET_TOKENS;
  }[];
  readonly markets: readonly { symbol: string; address: Address; successor: string }[];
};

export type RetiredKuruMarket = (typeof KURU_RETIRED_DEPLOYMENT.markets)[number];
export type RetiredKuruToken = (typeof KURU_RETIRED_DEPLOYMENT.tokens)[number];

/** The retired (Set-C) OrderBook an address names, or `undefined`. */
export function retiredKuruMarket(address: string): RetiredKuruMarket | undefined {
  const lower = address.toLowerCase();
  return KURU_RETIRED_DEPLOYMENT.markets.find((m) => m.address.toLowerCase() === lower);
}

/** The retired (Set-C) token an address names, or `undefined`. */
export function retiredKuruToken(address: string): RetiredKuruToken | undefined {
  const lower = address.toLowerCase();
  return KURU_RETIRED_DEPLOYMENT.tokens.find((t) => t.address.toLowerCase() === lower);
}

/**
 * A market address as a person reads it: the current symbol, a retired book's
 * symbol marked as retired, or the bare address for anything else.
 */
export function kuruMarketLabel(address: string): string {
  const lower = address.toLowerCase();
  const current = KURU_TESTNET_MARKETS.find((m) => m.address.toLowerCase() === lower);
  if (current) return current.symbol;
  const retired = retiredKuruMarket(address);
  return retired ? `${retired.symbol} (retired by Kuru)` : address;
}

/**
 * The current OrderBook a retired one's mandate entry moves to on an amend.
 * Throws for an address that is not a retired book.
 */
export function kuruMarketSuccessor(retired: string): KuruMarketConfig {
  const old = retiredKuruMarket(retired);
  const next = old && KURU_TESTNET_MARKETS.find((m) => m.symbol === old.successor);
  if (!next) throw new Error(`${retired} is not a retired Kuru market`);
  return next;
}

/** The current token a retired one's deposit cap moves to on an amend. Throws for any other address. */
export function kuruTokenSuccessor(retired: string): KuruToken {
  const old = retiredKuruToken(retired);
  if (!old) throw new Error(`${retired} is not a retired Kuru token`);
  return KURU_TESTNET_TOKENS[old.successor];
}

/**
 * The RETIRED deployment's faucet. It still pays, but only the retired tokens,
 * which the current books do not trade; the current deployment has none. Kept
 * for the historical scripts that claim from it. Nothing in the product does.
 *
 * One `claim()` paid 10,000 USDC, 1 WETH, 0.1 cbBTC and 1 XAUt (all Set C) to
 * the caller (observed: tx 0xe0e063e9055614f27e253ab7e41f737c00f0800a43453079fb6fe2ef26c5b314).
 * The cooldown is PER ADDRESS — `nextClaimAt(address)`.
 */
export const KURU_FAUCET = {
  address: KURU_RETIRED_DEPLOYMENT.contracts.testnetTokenFaucet,
  /** `claim()`. Pays `msg.sender`, so a Kernel account claims for itself. */
  claimSelector: '0x4e71d92d',
  /** `COOLDOWN()` = 43,200 s = 12 h between claims by the same address. */
  cooldownSeconds: 43_200,
  /** Measured: 261,237 gas from a fresh address. */
  claimGas: 270_000n,
} as const;

/**
 * Gas for each Kuru call, measured with `eth_estimateGas` from an EOA on
 * Monad testnet on 2026-09-10 (`scripts/kuru-live.ts`) — AGAINST THE RETIRED
 * SET-C CONTRACTS (SEN-185). The current AccountCore registers a root on the
 * first deposit and checks every withdrawal against the WithdrawalLimiter, so
 * `firstDeposit` and `withdraw` are unmeasured on it; re-measure before
 * trusting a tight limit. Monad charges on the
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
  /**
   * `AccountCore.withdraw` of USDC from an EOA's own account, the recipient
   * holding none yet (its balance slot goes 0 → nonzero, the dear case).
   * `eth_estimateGas` from agent 0xE05F…0B6E for its whole 14 USDC (SEN-15).
   */
  withdraw: 150_407n,
  /**
   * ERC-20 `transfer` of USDC between two holders (`eth_estimateGas`, SEN-15),
   * as an agent returns funds to its owner.
   */
  erc20Transfer: 46_525n,
  /**
   * claim + approve + deposit + place as one Kernel `execute`: the UserOperation's
   * `callGasLimit`. Landed for real in userOp 0x1c46d264…859857a; the
   * self-bundled `handleOps` transaction around it took 1,038,005.
   */
  kernelOnboardAndPlace: 812_498n,
  /** Cancel one slot as a Kernel UserOperation's `callGasLimit` (estimated, not landed). */
  kernelCancelOne: 266_556n,
} as const;
