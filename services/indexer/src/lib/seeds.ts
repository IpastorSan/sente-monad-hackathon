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
 * Kuru's account-id deployment (SEN-185), read back from the chain on
 * 2026-10-09: the five books the Data Source lists since 2026-09-25. The Set-C
 * books this table held before are retired; their fills are older than
 * `config.yaml`'s `start_block` and are not indexed.
 */
const USDC = { address: '0xa402b424f392eaa05dbc8779e4502a1f6a96fef1', decimals: 6 };

export const KURU_MARKETS: readonly KuruMarketSeed[] = [
  {
    marketId: 'kuru-0x26cd68436b6a4aeb3ec52abc20a4d121f8b4bac9',
    address: '0x26cd68436b6a4aeb3ec52abc20a4d121f8b4bac9',
    symbol: 'MON-USDC',
    base: 'MON',
    quote: 'USDC',
    pricePrecision: 1_000_000n,
    sizePrecision: 1_000_000n,
    baseDecimals: 18,
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
  },
] as const;

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

/** Kuru AccountCore proxy (the account-id deployment, SEN-185). */
export const KURU_ACCOUNT_CORE = '0xdbaade7b42c95399bb1e9614d51b5b9e2cf78038';

/** Native MON in AccountCore events. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** ERC-20 decimals for the tokens these markets trade; native is 18. */
export const KURU_TOKEN_DECIMALS: Readonly<Record<string, number>> = {
  [NATIVE_TOKEN]: 18,
  [USDC.address]: 6,
  ['0x63c84e18184021c6cce5ea57d0c3ec0e65f3b303']: 18, // WETH
  ['0x7cdc77b348a2e101c766ad290367f3c5f287af18']: 8, // WBTC
  ['0x7553b18a8c8400a1b7746c1f5b4f453d57555838']: 6, // XAUT
  ['0xf7d4179fc134d7cb6ba3d26b2fb556ff8903b666']: 6, // USDT
};

export function kuruTokenDecimals(token: string): number {
  return KURU_TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
}
