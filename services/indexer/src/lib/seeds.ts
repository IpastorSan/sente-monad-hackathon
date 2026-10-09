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

const USDC = { address: '0xee0722ead54f1b4fe97be399be43bc0226a6f97e', decimals: 6 };

export const KURU_MARKETS: readonly KuruMarketSeed[] = [
  {
    marketId: 'kuru-0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    address: '0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    symbol: 'MON-USDC',
    base: 'MON',
    quote: 'USDC',
    pricePrecision: 1_000_000n,
    sizePrecision: 100_000_000n,
    baseDecimals: 18,
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
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
    quoteDecimals: USDC.decimals,
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

/** Kuru AccountCore proxy. */
export const KURU_ACCOUNT_CORE = '0x6384e9b2bf3b65e1535403a0a543b5fda905ee22';

/** Native MON in AccountCore events. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** ERC-20 decimals for the tokens these markets trade; native is 18. */
export const KURU_TOKEN_DECIMALS: Readonly<Record<string, number>> = {
  [NATIVE_TOKEN]: 18,
  [USDC.address]: 6,
  ['0x8b6c5fafef85b030bb1e71ae7ac085cc2380aaf8']: 18, // WETH
  ['0xef2a20a161ac9ed1117d721336226b6399f15b4d']: 8, // cbBTC
  ['0xee1dce135a9ab598bca8cf3a28bdef6892100740']: 6, // XAUt
};

export function kuruTokenDecimals(token: string): number {
  return KURU_TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
}
