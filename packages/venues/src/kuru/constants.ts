/**
 * Kuru Spot V2 on Monad testnet (10143) — every address the adapter touches,
 * for BOTH deployments Kuru has run there, and the switch between them
 * (SEN-189).
 *
 * {@link KURU_DEPLOYMENTS} is the one source of truth:
 *
 * - **`set-d`** (the default) is Kuru's account-id deployment, the one
 *   published at `kuru-testnet-docs.mintlify.site/deployments/testnet`
 *   (markets created 2026-09-25) and the only one the Data Source catalog
 *   lists. Every address was read back from the chain on 2026-10-09 (SEN-185).
 *   Its custody is keyed by numeric account id — `deposit(rootOwner, …)`,
 *   `withdraw(rootAccountId, …, recipient)`, `getBalance(accountId, …)` — the
 *   `@toxicflow-labs/ts-sdk` 0.3.x ABI. Its test USDC is mint-by-owner only.
 * - **`set-c`** is the deployment before it (listed 2026-09-10 to 2026-09-25).
 *   Kuru's catalog and Gateway no longer list it, but its contracts still
 *   trade: on 2026-10-09 a GTC buy, a cancel, an IOC buy, an IOC sell and a
 *   withdraw all landed on it. Its custody is keyed by the caller's address —
 *   `deposit(token, amount)`, `withdraw(token, amount)` paying `msg.sender` —
 *   the 0.0.4 SDK's ABI, and its faucet still pays 10,000 USDC per address
 *   every 12 h.
 *
 * Which one Sente trades is `KURU_DEPLOYMENT` on the server and
 * `EXPO_PUBLIC_KURU_DEPLOYMENT` in the app build, read once at load. The
 * `KURU_TESTNET_*` exports below are the ACTIVE deployment's tables, so every
 * consumer follows the switch; the other deployment is
 * {@link KURU_RETIRED_DEPLOYMENT}, whose books and tokens an old mandate may
 * still name (CLAUDE.md gotcha 13).
 *
 * Every contract here is absent on mainnet 143, so a mainnet build must not
 * reuse this table.
 */
import type { Address } from 'viem';

export const KURU_TESTNET_CHAIN_ID = 10143;

/**
 * The three testnet API surfaces. `exchange.kuru.io` is mainnet-only and its
 * Binance-style routes 404 here.
 *
 * - Data Source: finalized catalogs, candles, trades, `/api/v1/...`.
 * - Exchange Gateway: current projected book and user snapshots. Read-only —
 *   there is no order-entry route on it.
 * - Relay: gas sponsorship for EIP-7702 trading EOAs. Not used for a Kernel
 *   account, which calls the OrderBook itself (see `adapter.ts`).
 *
 * All three serve Set D only: for a Set-C book the Data Source answers
 * `404 market not found` (candles included) and the Gateway `unknown symbol`
 * (checked 2026-10-12).
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

export type KuruDeploymentId = 'set-c' | 'set-d';

export const KURU_DEPLOYMENT_IDS: readonly KuruDeploymentId[] = ['set-c', 'set-d'];

/** What an unset `KURU_DEPLOYMENT` means: the deployment Kuru itself lists. */
export const DEFAULT_KURU_DEPLOYMENT: KuruDeploymentId = 'set-d';

/**
 * How an AccountCore keys custody, which decides the deposit/withdraw/balance
 * ABI:
 *
 * - `address-keyed` (Set C, ts-sdk 0.0.4): `deposit(token, amount)` credits
 *   the caller, `withdraw(token, amount)` pays the caller,
 *   `getBalanceById(id, token)`, `userRegistry(owner)` → id.
 * - `account-id` (Set D, ts-sdk 0.3.x): `deposit(rootOwner, token, amount)`
 *   credits whoever it names, `withdraw(rootAccountId, token, amount,
 *   recipient)` pays whoever it names, `getBalance(id, token)`,
 *   `rootAccountIdOf(owner)` → id.
 *
 * The OrderBook's `batch` overloads, `TradesPacked`, `approveBuilder` and
 * `getBuilderApproval` are the same on both.
 */
export type KuruCustody = 'address-keyed' | 'account-id';

/** The tokens every deployment has under these keys; the rest vary. */
export type KuruDeploymentTokens = {
  readonly MON: KuruToken;
  readonly USDC: KuruToken;
  readonly WETH: KuruToken;
  readonly [symbol: string]: KuruToken;
};

export type KuruDeployment = {
  readonly id: KuruDeploymentId;
  /** For people: what to call it in a log line or a doc. */
  readonly label: string;
  readonly custody: KuruCustody;
  /**
   * Whether Kuru's Data Source and Gateway serve this deployment's books. When
   * `false` the market list is the pinned table and prices come from the
   * chain; there are no candles and no catalog to compare the pins against.
   */
  readonly catalogListed: boolean;
  /**
   * For a deployment Kuru serves no candles for, the Perpl perp whose candles
   * stand in as a labelled price REFERENCE, by Kuru symbol (SEN-199). Never
   * Kuru fills: {@link kuruCandleReference} carries the reason with it.
   */
  readonly candleReferences?: Readonly<Record<string, string>>;
  readonly contracts: {
    /** Custody, account ids, signer permissions. ERC-1967 proxy. */
    readonly accountCore: Address;
    /** Market registry; every OrderBook's `owner()`. ERC-1967 proxy. */
    readonly spotRouter: Address;
    /** Implementation behind every market proxy. Never call it directly. */
    readonly orderBookImplementation: Address;
    /** EIP-7702 delegate for Relay-sponsored trading EOAs. Unused by this adapter. */
    readonly kuruTradingWallet: Address;
    /** Set D: the withdrawal budget AccountCore checks every `withdraw` against. */
    readonly withdrawalLimiter?: Address;
    /** Set C: the public faucet for its tokens. Set D has none. */
    readonly testnetTokenFaucet?: Address;
  };
  readonly tokens: KuruDeploymentTokens;
  readonly markets: readonly KuruMarketConfig[];
  /**
   * The book live checks trade by default: one that had quotes on both sides
   * when last looked at (2026-10-09). MON-USDC was empty on both deployments.
   */
  readonly liquidMarket: string;
  /**
   * `getMarketParams()` common to every book: `minQuoteNotional` 10 USDC,
   * `maxQuoteNotional` 5,000,000 USDC, taker 7,000 pps (0.07%), maker 4,000
   * pps (0.04%) — the same on both deployments. The adapter still reads the
   * params live before it signs and refuses a book whose precisions differ
   * from its row here.
   */
  readonly minQuoteNotionalAtoms: bigint;
};

const SET_D_TOKENS = {
  MON: { symbol: 'MON', address: NATIVE_TOKEN, decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1', decimals: 6 },
  WETH: { symbol: 'WETH', address: '0x63c84e18184021c6CcE5ea57d0c3Ec0E65f3b303', decimals: 18 },
  WBTC: { symbol: 'WBTC', address: '0x7cDC77B348a2E101C766aD290367f3c5F287af18', decimals: 8 },
  XAUT: { symbol: 'XAUT', address: '0x7553b18A8c8400a1b7746C1F5b4f453D57555838', decimals: 6 },
  USDT: { symbol: 'USDT', address: '0xF7d4179FC134D7Cb6BA3D26B2fb556Ff8903B666', decimals: 6 },
} as const satisfies Record<string, KuruToken>;

const SET_C_TOKENS = {
  MON: { symbol: 'MON', address: NATIVE_TOKEN, decimals: 18 },
  USDC: { symbol: 'USDC', address: '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E', decimals: 6 },
  // Kuru's deployment page printed this with a broken EIP-55 checksum
  // (`…380aaf8`), which viem rejects at call time. This is the valid form.
  WETH: { symbol: 'WETH', address: '0x8B6C5fafeF85B030bB1e71ae7ac085cC2380aAf8', decimals: 18 },
  cbBTC: { symbol: 'cbBTC', address: '0xef2a20a161ac9ed1117d721336226b6399F15b4D', decimals: 8 },
  // The deployment page called this "XAUt0"; the token's own `symbol()` says "XAUt".
  XAUt: { symbol: 'XAUt', address: '0xee1Dce135a9aB598bca8CF3a28bDEF6892100740', decimals: 6 },
} as const satisfies Record<string, KuruToken>;

/**
 * Both deployments. Set D's rows as `getMarketParams()` answered on
 * 2026-10-09 (SEN-185); Set C's as they were pinned from 2026-09-10 until
 * then (MON-USDC's `sizePrecision` is 10^8 there, 10^6 on Set D). Set C's
 * books on 2026-10-09: cbBTC-USDC and XAUt-USDC quoted, MON-USDC and
 * WETH-USDC empty.
 */
export const KURU_DEPLOYMENTS: Readonly<Record<KuruDeploymentId, KuruDeployment>> = {
  'set-d': {
    id: 'set-d',
    label: "Kuru's current testnet deployment (Set D)",
    custody: 'account-id',
    catalogListed: true,
    contracts: {
      accountCore: '0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038',
      spotRouter: '0xf75A7529b83941e001d7D9bc113A73C92112947E',
      orderBookImplementation: '0xa4171E141A3Cf7801d7f06C126284aC0a509e6a9',
      kuruTradingWallet: '0x43F4BCA50dE3bbcB0A297227fA61Cf3bf2dE0dE1',
      withdrawalLimiter: '0x6d9599d6B9A5Cf601C2cdBc43fF170462B256fe0',
    },
    tokens: SET_D_TOKENS,
    liquidMarket: 'WETH-USDC',
    minQuoteNotionalAtoms: 10_000_000n,
    markets: [
      {
        symbol: 'MON-USDC',
        venueSymbol: 'MONUSDC',
        address: '0x26cd68436B6A4AEB3ec52abC20A4d121f8B4BAc9',
        base: SET_D_TOKENS.MON,
        quote: SET_D_TOKENS.USDC,
        pricePrecision: 1_000_000n,
        sizePrecision: 1_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'WETH-USDC',
        venueSymbol: 'WETHUSDC',
        address: '0x9d187971B64505Ac81f12c5FD2ac9c5247Ec62F3',
        base: SET_D_TOKENS.WETH,
        quote: SET_D_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 10_000_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'WBTC-USDC',
        venueSymbol: 'WBTCUSDC',
        address: '0x8661cB7c5f4f8ae3ee116B63Aa5a23c69110e357',
        base: SET_D_TOKENS.WBTC,
        quote: SET_D_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 100_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'XAUT-USDC',
        venueSymbol: 'XAUTUSDC',
        address: '0x0E2A5D9378fB61B8eC100Bd770c449F6fdD3e4d6',
        base: SET_D_TOKENS.XAUT,
        quote: SET_D_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 1_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'USDT-USDC',
        venueSymbol: 'USDTUSDC',
        address: '0x4A0888C502e64AEAE11115508Ec0955c70293dba',
        base: SET_D_TOKENS.USDT,
        quote: SET_D_TOKENS.USDC,
        pricePrecision: 1_000_000n,
        sizePrecision: 1_000_000n,
        tickSize: 1n,
      },
    ],
  },
  'set-c': {
    id: 'set-c',
    label: "Kuru's previous testnet deployment (Set C)",
    custody: 'address-keyed',
    catalogListed: false,
    // Perpl's open perps on 2026-10-12: BTC, ETH, SOL, MON, ZEC, LIT, PUMP,
    // NEAR. No gold, so XAUt-USDC has no reference.
    candleReferences: {
      'cbBTC-USDC': 'BTC-PERP',
      'WETH-USDC': 'ETH-PERP',
      'MON-USDC': 'MON-PERP',
    },
    contracts: {
      accountCore: '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22',
      spotRouter: '0xba24a1042701f06e8F7edCF04389260D1Fa4c697',
      orderBookImplementation: '0xE20f57e673d7F254279c19270862A3d1E6F5B0d4',
      kuruTradingWallet: '0xc7f2a9761276F7050D6561d2FDC51abC993F45E9',
      testnetTokenFaucet: '0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9',
    },
    tokens: SET_C_TOKENS,
    liquidMarket: 'cbBTC-USDC',
    minQuoteNotionalAtoms: 10_000_000n,
    markets: [
      {
        symbol: 'MON-USDC',
        venueSymbol: 'MONUSDC',
        address: '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61',
        base: SET_C_TOKENS.MON,
        quote: SET_C_TOKENS.USDC,
        pricePrecision: 1_000_000n,
        sizePrecision: 100_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'WETH-USDC',
        venueSymbol: 'WETHUSDC',
        address: '0xa9C2936656a7D2143720BcD91Ba8506200B7CbE7',
        base: SET_C_TOKENS.WETH,
        quote: SET_C_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 10_000_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'cbBTC-USDC',
        venueSymbol: 'CBBTCUSDC',
        address: '0x5BDEA6F9F9abA34F4EcB9B865646A792b835ef7f',
        base: SET_C_TOKENS.cbBTC,
        quote: SET_C_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 100_000_000n,
        tickSize: 1n,
      },
      {
        symbol: 'XAUt-USDC',
        venueSymbol: 'XAUTUSDC',
        address: '0x0B4dD2A7b09d5c5401149fFe51301Cc589017343',
        base: SET_C_TOKENS.XAUt,
        quote: SET_C_TOKENS.USDC,
        pricePrecision: 100n,
        sizePrecision: 1_000_000n,
        tickSize: 1n,
      },
    ],
  },
};

/**
 * Which book and token of one deployment stands for which of the other, by
 * symbol: what an amend moves an old mandate's entry to. `null` where the
 * other deployment has no counterpart (Set D's USDT and USDT-USDC).
 */
const COUNTERPARTS: {
  readonly markets: readonly Readonly<Record<KuruDeploymentId, string | null>>[];
  readonly tokens: readonly Readonly<Record<KuruDeploymentId, string | null>>[];
} = {
  markets: [
    { 'set-c': 'MON-USDC', 'set-d': 'MON-USDC' },
    { 'set-c': 'WETH-USDC', 'set-d': 'WETH-USDC' },
    { 'set-c': 'cbBTC-USDC', 'set-d': 'WBTC-USDC' },
    { 'set-c': 'XAUt-USDC', 'set-d': 'XAUT-USDC' },
    { 'set-c': null, 'set-d': 'USDT-USDC' },
  ],
  tokens: [
    { 'set-c': 'USDC', 'set-d': 'USDC' },
    { 'set-c': 'WETH', 'set-d': 'WETH' },
    { 'set-c': 'cbBTC', 'set-d': 'WBTC' },
    { 'set-c': 'XAUt', 'set-d': 'XAUT' },
    { 'set-c': null, 'set-d': 'USDT' },
  ],
};

/**
 * `KURU_DEPLOYMENT` / `EXPO_PUBLIC_KURU_DEPLOYMENT` as a deployment id. Unset
 * or blank is {@link DEFAULT_KURU_DEPLOYMENT}; anything else that is not an id
 * throws, so a typo cannot silently trade the wrong books.
 */
export function parseKuruDeploymentId(raw: string | undefined | null): KuruDeploymentId {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_KURU_DEPLOYMENT;
  if ((KURU_DEPLOYMENT_IDS as readonly string[]).includes(value)) {
    return value as KuruDeploymentId;
  }
  throw new Error(`KURU_DEPLOYMENT must be one of ${KURU_DEPLOYMENT_IDS.join(', ')}, got ${raw}`);
}

/**
 * The raw switch. The server sets `KURU_DEPLOYMENT`; the app build sets
 * `EXPO_PUBLIC_KURU_DEPLOYMENT`, which Expo inlines only where it is written
 * out in full as below — so it is, and each read is guarded because a web
 * bundle may have no `process` at all.
 */
function deploymentFromEnv(): string | undefined {
  let server: string | undefined;
  let app: string | undefined;
  try {
    server = process.env.KURU_DEPLOYMENT;
  } catch {
    server = undefined;
  }
  try {
    app = process.env.EXPO_PUBLIC_KURU_DEPLOYMENT;
  } catch {
    app = undefined;
  }
  return server || app || undefined;
}

/** The deployment this process trades, fixed at load. */
export const KURU_DEPLOYMENT: KuruDeployment =
  KURU_DEPLOYMENTS[parseKuruDeploymentId(deploymentFromEnv())];

/** A deployment by id; the active one without an argument. */
export function kuruDeployment(id?: KuruDeploymentId): KuruDeployment {
  return id === undefined ? KURU_DEPLOYMENT : KURU_DEPLOYMENTS[id];
}

/** A Perpl perp's candles standing in for a Kuru market that has none (SEN-199). */
export type KuruCandleReference = {
  readonly venue: 'perpl';
  readonly symbol: string;
  /** Why the series is not the market's own, for whoever reads it. */
  readonly reason: string;
};

/**
 * The reference series for `symbol` on `deployment`, or `null` when Kuru
 * serves the market's own candles (Set D) or no perp matches it.
 */
export function kuruCandleReference(
  symbol: string,
  deployment: KuruDeployment = KURU_DEPLOYMENT,
): KuruCandleReference | null {
  if (deployment.catalogListed) return null;
  const perp = deployment.candleReferences?.[symbol];
  if (perp === undefined) return null;
  return {
    venue: 'perpl',
    symbol: perp,
    reason: `Kuru ${deployment.id} has no candle history`,
  };
}

/** The deployment this process does NOT trade. */
const INACTIVE_DEPLOYMENT: KuruDeployment =
  KURU_DEPLOYMENTS[KURU_DEPLOYMENT.id === 'set-c' ? 'set-d' : 'set-c'];

/** The active deployment's contracts. */
export const KURU_TESTNET_CONTRACTS: KuruDeployment['contracts'] = KURU_DEPLOYMENT.contracts;

/**
 * The active deployment's tokens. Kuru Test USDC is the quote asset of every
 * market — NOT Agora's AUSD, the Perpl leg's collateral — and each deployment
 * has its own USDC. Set D's are admin-minted with no public faucet; Set C's
 * come from {@link KURU_FAUCET}. AccountCore also enables LINK on Set D, but
 * no market trades it, so it is left out.
 */
export const KURU_TESTNET_TOKENS: KuruDeploymentTokens = KURU_DEPLOYMENT.tokens;

/** The active deployment's markets. */
export const KURU_TESTNET_MARKETS: readonly KuruMarketConfig[] = KURU_DEPLOYMENT.markets;

/** One book or token of the inactive deployment, and its active counterpart's symbol. */
export type RetiredKuruMarket = {
  readonly symbol: string;
  readonly address: Address;
  /** The active market an amend moves it to; `null` when there is none. */
  readonly successor: string | null;
};
export type RetiredKuruToken = RetiredKuruMarket;

/**
 * THE DEPLOYMENT THIS PROCESS DOES NOT TRADE, as the books and tokens an old
 * mandate or live Privy policy may still name (CLAUDE.md gotcha 13). With
 * Set D active this is Set C — every agent hired before 2026-10-09 — and with
 * Set C active it is Set D, every agent hired from then until the switch.
 * Nothing new may be signed against it.
 *
 * `successor` is the active market a retired book's mandate entry moves to on
 * an amend, and the active token a retired token's deposit cap moves to;
 * `null` where the active deployment has no counterpart, and the amend drops
 * the entry. Native MON is the same address on both and never retired.
 */
export const KURU_RETIRED_DEPLOYMENT: {
  readonly id: KuruDeploymentId;
  readonly contracts: KuruDeployment['contracts'];
  readonly tokens: readonly RetiredKuruToken[];
  readonly markets: readonly RetiredKuruMarket[];
} = {
  id: INACTIVE_DEPLOYMENT.id,
  contracts: INACTIVE_DEPLOYMENT.contracts,
  tokens: Object.values(INACTIVE_DEPLOYMENT.tokens)
    .filter((t) => t.address !== NATIVE_TOKEN)
    .map((t) => ({
      symbol: t.symbol,
      address: t.address,
      successor: counterpart(COUNTERPARTS.tokens, INACTIVE_DEPLOYMENT.id, t.symbol),
    })),
  markets: INACTIVE_DEPLOYMENT.markets.map((m) => ({
    symbol: m.symbol,
    address: m.address,
    successor: counterpart(COUNTERPARTS.markets, INACTIVE_DEPLOYMENT.id, m.symbol),
  })),
};

function counterpart(
  pairs: readonly Readonly<Record<KuruDeploymentId, string | null>>[],
  from: KuruDeploymentId,
  symbol: string,
): string | null {
  const to: KuruDeploymentId = from === 'set-c' ? 'set-d' : 'set-c';
  return pairs.find((pair) => pair[from] === symbol)?.[to] ?? null;
}

/** The retired OrderBook an address names, or `undefined`. */
export function retiredKuruMarket(address: string): RetiredKuruMarket | undefined {
  const lower = address.toLowerCase();
  return KURU_RETIRED_DEPLOYMENT.markets.find((m) => m.address.toLowerCase() === lower);
}

/** The retired token an address names, or `undefined`. */
export function retiredKuruToken(address: string): RetiredKuruToken | undefined {
  const lower = address.toLowerCase();
  return KURU_RETIRED_DEPLOYMENT.tokens.find((t) => t.address.toLowerCase() === lower);
}

/**
 * A market address as a person reads it: the active symbol, a retired book's
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
 * The active OrderBook a retired one's mandate entry moves to on an amend, or
 * `null` when the active deployment has no counterpart. Throws for an address
 * that is not a retired book.
 */
export function kuruMarketSuccessor(retired: string): KuruMarketConfig | null {
  const old = retiredKuruMarket(retired);
  if (!old) throw new Error(`${retired} is not a retired Kuru market`);
  return KURU_TESTNET_MARKETS.find((m) => m.symbol === old.successor) ?? null;
}

/**
 * The active token a retired one's deposit cap moves to on an amend, or `null`
 * when there is none. Throws for any other address.
 */
export function kuruTokenSuccessor(retired: string): KuruToken | null {
  const old = retiredKuruToken(retired);
  if (!old) throw new Error(`${retired} is not a retired Kuru token`);
  return old.successor === null ? null : (KURU_TESTNET_TOKENS[old.successor] ?? null);
}

/**
 * Set C's TestnetTokenFaucet, the only one either deployment has. It pays only
 * Set C's tokens, so it funds the product only while Set C is active
 * (`pnpm --filter @sente/api run kuru:faucet`).
 *
 * One `claim()` paid 10,000 USDC, 1 WETH, 0.1 cbBTC and 1 XAUt to the caller
 * (observed: tx 0xe0e063e9055614f27e253ab7e41f737c00f0800a43453079fb6fe2ef26c5b314).
 * The cooldown is PER ADDRESS — `nextClaimAt(address)`.
 */
export const KURU_FAUCET = {
  address: '0x25B1416FcD3400bE2D8F50bbe7Cf1101b8B891E9',
  /** `claim()`. Pays `msg.sender`, so a Kernel account claims for itself. */
  claimSelector: '0x4e71d92d',
  /** `nextClaimAt(address)`: Unix seconds, `0` for an address that never claimed. */
  nextClaimAtSelector: '0x11a163e9',
  /** `COOLDOWN()` = 43,200 s = 12 h between claims by the same address. */
  cooldownSeconds: 43_200,
  /** What one claim pays in Set-C USDC atoms (`USDC_AMOUNT()`). */
  usdcPerClaimAtoms: 10_000_000_000n,
  /** Measured: 261,237 gas from a fresh address. */
  claimGas: 270_000n,
} as const satisfies Record<string, unknown> & { address: Address };

/**
 * Gas for each Kuru call, measured with `eth_estimateGas` from an EOA on
 * Monad testnet on 2026-09-10 (`scripts/kuru-live.ts`) — AGAINST SET C, so
 * they fit Set C as measured. Set D's AccountCore registers a root on the
 * first deposit and checks every withdrawal against the WithdrawalLimiter, so
 * `firstDeposit` and `withdraw` are unmeasured there; re-measure before
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
