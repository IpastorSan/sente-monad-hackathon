/**
 * Market constants, mirrored from packages/venues/src/kuru/constants.ts and
 * docs/monad-testnet-assets.md.
 * The indexer is standalone (not a workspace member) and Envio runs handlers
 * through its own tsx loader, so this table is duplicated rather than
 * imported. `seeds.test.ts` pins the parts that have a counterpart in the
 * venue packages; an address or precision change there must be copied here.
 */

export const MONAD_TESTNET_CHAIN_ID = 10143;

/**
 * One market row — the shape `entities/Market` wants.
 */
export type MarketSeed = {
  readonly marketId: string;
  readonly venue: 'KURU';
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Book price units per 1 quote-per-base. */
  readonly pricePrecision: bigint;
  /** Book size units per 1 base. */
  readonly sizePrecision: bigint;
  /** ERC-20 decimals of the base token (display metadata). */
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  /** The OrderBook proxy (lowercase) that emits this market. */
  readonly address?: string;
};

/** Kuru OrderBook proxies, one per market (lowercase for keying). */
export type KuruMarketSeed = {
  readonly marketId: string; // "kuru-<address lowercase>"
  readonly address: string;
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
};

/**
 * Which Kuru deployment this indexer follows (SEN-189). Kuru has run two on
 * testnet, and Sente trades one of them (`KURU_DEPLOYMENT` in the API and
 * packages/venues/src/kuru/constants.ts):
 *
 * - `set-d` (default): the account-id deployment Kuru lists since 2026-09-25,
 *   indexed by `config.yaml`.
 * - `set-c`: the previous deployment, still trading on chain, indexed by
 *   `config.setc.yaml`.
 *
 * Read from `ENVIO_KURU_DEPLOYMENT` (Envio's hosted service only passes
 * `ENVIO_`-prefixed variables) or `KURU_DEPLOYMENT`, and it must name the same
 * deployment as the config file the indexer was started with: a fill from a
 * book of the other deployment is skipped with a warning, never decoded at the
 * wrong precision.
 */
export type KuruDeploymentId = 'set-c' | 'set-d';

/**
 * The deployment when no variable says otherwise. Envio Cloud's free plan has
 * no environment variables, so the hosted indexer follows this constant: keep
 * it equal to the deployment production trades (`KURU_DEPLOYMENT` on the API)
 * and to the config file the Envio project builds. Set C since 2026-10-12.
 */
export const DEFAULT_KURU_DEPLOYMENT: KuruDeploymentId = 'set-c';

export function kuruDeploymentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): KuruDeploymentId {
  const raw = (env['ENVIO_KURU_DEPLOYMENT'] || env['KURU_DEPLOYMENT'] || '').trim().toLowerCase();
  if (raw === '') return DEFAULT_KURU_DEPLOYMENT;
  if (raw === 'set-d') return 'set-d';
  if (raw === 'set-c') return 'set-c';
  throw new Error(`ENVIO_KURU_DEPLOYMENT must be set-c or set-d, got ${raw}`);
}

/**
 * Set D (SEN-185), read back from the chain on 2026-10-09: the five books the
 * Data Source lists since 2026-09-25.
 */
const SET_D_USDC = { address: '0xa402b424f392eaa05dbc8779e4502a1f6a96fef1', decimals: 6 };

const SET_D_MARKETS: readonly KuruMarketSeed[] = [
  {
    marketId: 'kuru-0x26cd68436b6a4aeb3ec52abc20a4d121f8b4bac9',
    address: '0x26cd68436b6a4aeb3ec52abc20a4d121f8b4bac9',
    symbol: 'MON-USDC',
    base: 'MON',
    quote: 'USDC',
    pricePrecision: 1_000_000n,
    sizePrecision: 1_000_000n,
    baseDecimals: 18,
    quoteDecimals: SET_D_USDC.decimals,
  },
  {
    marketId: 'kuru-0x9d187971b64505ac81f12c5fd2ac9c5247ec62f3',
    address: '0x9d187971b64505ac81f12c5fd2ac9c5247ec62f3',
    symbol: 'WETH-USDC',
    base: 'WETH',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 10_000_000_000n,
    baseDecimals: 18,
    quoteDecimals: SET_D_USDC.decimals,
  },
  {
    marketId: 'kuru-0x8661cb7c5f4f8ae3ee116b63aa5a23c69110e357',
    address: '0x8661cb7c5f4f8ae3ee116b63aa5a23c69110e357',
    symbol: 'WBTC-USDC',
    base: 'WBTC',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 100_000_000n,
    baseDecimals: 8,
    quoteDecimals: SET_D_USDC.decimals,
  },
  {
    marketId: 'kuru-0x0e2a5d9378fb61b8ec100bd770c449f6fdd3e4d6',
    address: '0x0e2a5d9378fb61b8ec100bd770c449f6fdd3e4d6',
    symbol: 'XAUT-USDC',
    base: 'XAUT',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 1_000_000n,
    baseDecimals: 6,
    quoteDecimals: SET_D_USDC.decimals,
  },
  {
    marketId: 'kuru-0x4a0888c502e64aeae11115508ec0955c70293dba',
    address: '0x4a0888c502e64aeae11115508ec0955c70293dba',
    symbol: 'USDT-USDC',
    base: 'USDT',
    quote: 'USDC',
    pricePrecision: 1_000_000n,
    sizePrecision: 1_000_000n,
    baseDecimals: 6,
    quoteDecimals: SET_D_USDC.decimals,
  },
] as const;

/**
 * Set C, as Sente pinned it from 2026-09-10 until SEN-185: four books, its own
 * USDC. MON-USDC's book sizes in 10^8 here (10^6 on Set D).
 */
const SET_C_USDC = { address: '0xee0722ead54f1b4fe97be399be43bc0226a6f97e', decimals: 6 };

const SET_C_MARKETS: readonly KuruMarketSeed[] = [
  {
    marketId: 'kuru-0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    address: '0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    symbol: 'MON-USDC',
    base: 'MON',
    quote: 'USDC',
    pricePrecision: 1_000_000n,
    sizePrecision: 100_000_000n,
    baseDecimals: 18,
    quoteDecimals: SET_C_USDC.decimals,
  },
  {
    marketId: 'kuru-0xa9c2936656a7d2143720bcd91ba8506200b7cbe7',
    address: '0xa9c2936656a7d2143720bcd91ba8506200b7cbe7',
    symbol: 'WETH-USDC',
    base: 'WETH',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 10_000_000_000n,
    baseDecimals: 18,
    quoteDecimals: SET_C_USDC.decimals,
  },
  {
    marketId: 'kuru-0x5bdea6f9f9aba34f4ecb9b865646a792b835ef7f',
    address: '0x5bdea6f9f9aba34f4ecb9b865646a792b835ef7f',
    symbol: 'cbBTC-USDC',
    base: 'cbBTC',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 100_000_000n,
    baseDecimals: 8,
    quoteDecimals: SET_C_USDC.decimals,
  },
  {
    marketId: 'kuru-0x0b4dd2a7b09d5c5401149ffe51301cc589017343',
    address: '0x0b4dd2a7b09d5c5401149ffe51301cc589017343',
    symbol: 'XAUt-USDC',
    base: 'XAUt',
    quote: 'USDC',
    pricePrecision: 100n,
    sizePrecision: 1_000_000n,
    baseDecimals: 6,
    quoteDecimals: SET_C_USDC.decimals,
  },
];

/** Native MON in AccountCore events. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** One deployment's tables. */
export type KuruDeploymentSeeds = {
  readonly id: KuruDeploymentId;
  readonly markets: readonly KuruMarketSeed[];
  /** AccountCore proxy, lowercase. */
  readonly accountCore: string;
  /**
   * The AccountCore getter that turns an id into the address a Sente agent is
   * matched on: `getAccountOwner` (Set D, the root owner) or `userAddressById`
   * (Set C). Each reverts on the other deployment.
   */
  readonly accountAddressGetter: 'getAccountOwner' | 'userAddressById';
  /** ERC-20 decimals for the tokens these markets trade; native is 18. */
  readonly tokenDecimals: Readonly<Record<string, number>>;
};

export const KURU_DEPLOYMENT_SEEDS: Readonly<Record<KuruDeploymentId, KuruDeploymentSeeds>> = {
  'set-d': {
    id: 'set-d',
    markets: SET_D_MARKETS,
    accountCore: '0xdbaade7b42c95399bb1e9614d51b5b9e2cf78038',
    accountAddressGetter: 'getAccountOwner',
    tokenDecimals: {
      [NATIVE_TOKEN]: 18,
      [SET_D_USDC.address]: 6,
      ['0x63c84e18184021c6cce5ea57d0c3ec0e65f3b303']: 18, // WETH
      ['0x7cdc77b348a2e101c766ad290367f3c5f287af18']: 8, // WBTC
      ['0x7553b18a8c8400a1b7746c1f5b4f453d57555838']: 6, // XAUT
      ['0xf7d4179fc134d7cb6ba3d26b2fb556ff8903b666']: 6, // USDT
    },
  },
  'set-c': {
    id: 'set-c',
    markets: SET_C_MARKETS,
    accountCore: '0x6384e9b2bf3b65e1535403a0a543b5fda905ee22',
    accountAddressGetter: 'userAddressById',
    tokenDecimals: {
      [NATIVE_TOKEN]: 18,
      [SET_C_USDC.address]: 6,
      ['0x8b6c5fafef85b030bb1e71ae7ac085cc2380aaf8']: 18, // WETH
      ['0xef2a20a161ac9ed1117d721336226b6399f15b4d']: 8, // cbBTC
      ['0xee1dce135a9ab598bca8cf3a28bdef6892100740']: 6, // XAUt
    },
  },
};

/** The deployment this process indexes, fixed at load. */
export const KURU_DEPLOYMENT: KuruDeploymentSeeds = KURU_DEPLOYMENT_SEEDS[kuruDeploymentFromEnv()];

/** The active deployment's markets. */
export const KURU_MARKETS: readonly KuruMarketSeed[] = KURU_DEPLOYMENT.markets;

export const KURU_MARKET_SEEDS: readonly MarketSeed[] = KURU_MARKETS.map((m) => ({
  marketId: m.marketId,
  venue: 'KURU',
  symbol: m.symbol,
  base: m.base,
  quote: m.quote,
  pricePrecision: m.pricePrecision,
  sizePrecision: m.sizePrecision,
  baseDecimals: m.baseDecimals,
  quoteDecimals: m.quoteDecimals,
  address: m.address,
}));

export function kuruMarketByAddress(address: string): KuruMarketSeed | undefined {
  const lower = address.toLowerCase();
  return KURU_MARKETS.find((m) => m.address === lower);
}

/** The active deployment's AccountCore proxy, lowercase. */
export const KURU_ACCOUNT_CORE = KURU_DEPLOYMENT.accountCore;

/** ERC-20 decimals for the active deployment's tokens; native is 18. */
export const KURU_TOKEN_DECIMALS: Readonly<Record<string, number>> = KURU_DEPLOYMENT.tokenDecimals;

export function kuruTokenDecimals(token: string): number {
  return KURU_TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
}
