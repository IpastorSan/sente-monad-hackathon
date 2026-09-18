/**
 * Market constants, mirrored from packages/venues/src/kuru/constants.ts,
 * packages/venues/src/perpl/constants.ts and docs/monad-testnet-assets.md.
 * The indexer is standalone (not a workspace member) and Envio runs handlers
 * through its own tsx loader, so this table is duplicated rather than
 * imported. `seeds.test.ts` pins the parts that have a counterpart in the
 * venue packages; an address or precision change there must be copied here.
 */

export const MONAD_TESTNET_CHAIN_ID = 10143;

/**
 * One market row, venue-neutral — the shape `entities/Market` wants, so
 * handlers never branch on venue when seeding.
 */
export type MarketSeed = {
  readonly marketId: string;
  readonly venue: 'KURU' | 'PERPL';
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Kuru: book price units per 1 quote-per-base. Perpl: 10^price_decimals. */
  readonly pricePrecision: bigint;
  /** Kuru: book size units per 1 base. Perpl: 10^size_decimals. */
  readonly sizePrecision: bigint;
  /** ERC-20 decimals of the base token (Kuru only; display metadata). */
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  /** Kuru only: the OrderBook proxy (lowercase) that emits this market. */
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

/**
 * Perpl markets as served by GET /api/v1/pub/context on 2026-09-17
 * (instance 12 = Exchange 0x1964…80cc). price_decimals / size_decimals scale
 * the on-chain PNS / LNS integers: humanPrice = pricePNS / 10^priceDecimals,
 * humanSize = lotLNS / 10^sizeDecimals. CNS (collateral) is AUSD, 6 decimals.
 *
 * The `perpId`s are powers of two by construction, which is why the id is
 * used as the join key rather than the symbol.
 */
export type PerplMarketSeed = {
  readonly marketId: string; // "perpl-<perpId>"
  readonly perpId: bigint;
  readonly base: string;
  readonly priceDecimals: number;
  readonly sizeDecimals: number;
};

export const PERP_COLLATERAL_DECIMALS = 6; // AUSD

/** Agora AUSD on Monad testnet — the collateral token Perpl's events are priced in. */
export const PERPL_COLLATERAL = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';

/**
 * Perpl's Exchange proxy (instance 12), the contract every event in
 * config.yaml comes from. Named here because `accountAddress.ts` reads it
 * directly; config.yaml stays the source of truth for what is *indexed*.
 */
export const PERPL_EXCHANGE = '0x1964c32f0be608e7d29302aff5e61268e72080cc';

export const PERPL_MARKETS: readonly PerplMarketSeed[] = [
  { marketId: 'perpl-16', perpId: 16n, base: 'BTC', priceDecimals: 1, sizeDecimals: 5 },
  { marketId: 'perpl-32', perpId: 32n, base: 'ETH', priceDecimals: 2, sizeDecimals: 3 },
  { marketId: 'perpl-48', perpId: 48n, base: 'SOL', priceDecimals: 2, sizeDecimals: 3 },
  { marketId: 'perpl-64', perpId: 64n, base: 'MON', priceDecimals: 5, sizeDecimals: 0 },
  { marketId: 'perpl-256', perpId: 256n, base: 'ZEC', priceDecimals: 3, sizeDecimals: 3 },
  { marketId: 'perpl-272', perpId: 272n, base: 'LIT', priceDecimals: 5, sizeDecimals: 1 },
  { marketId: 'perpl-320', perpId: 320n, base: 'PUMP', priceDecimals: 6, sizeDecimals: 0 },
] as const;

export const perplMarketId = (perpId: bigint): string => `perpl-${perpId}`;

/** Perpl `price_decimals`/`size_decimals` are decimal counts, not precisions. */
export function perplMarketSeed(seed: PerplMarketSeed): MarketSeed {
  return {
    marketId: seed.marketId,
    venue: 'PERPL',
    symbol: `${seed.base}-PERP`,
    base: seed.base,
    quote: 'AUSD',
    pricePrecision: 10n ** BigInt(seed.priceDecimals),
    sizePrecision: 10n ** BigInt(seed.sizeDecimals),
    baseDecimals: seed.sizeDecimals,
    quoteDecimals: PERP_COLLATERAL_DECIMALS,
  };
}

export const PERPL_MARKET_SEEDS: readonly MarketSeed[] = PERPL_MARKETS.map(perplMarketSeed);

export function perplMarketByPerpId(perpId: bigint): PerplMarketSeed | undefined {
  return PERPL_MARKETS.find((m) => m.perpId === perpId);
}

/**
 * The handler-facing lookup: the same market, in the venue-neutral `MarketSeed`
 * shape, so handlers read `sizePrecision`/`pricePrecision` and derive the
 * decimal counts with `decimalsFromPrecision` — one source of truth instead of
 * a `priceDecimals` copy that can drift from it.
 */
export function perplMarketSeedByPerpId(perpId: bigint): MarketSeed | undefined {
  const seed = perplMarketByPerpId(perpId);
  return seed === undefined ? undefined : perplMarketSeed(seed);
}

/**
 * A market from Perpl's `ContractAdded`, for a perpetual listed *inside* the
 * indexed range. Carries the decimals on the event, so nothing is assumed.
 */
export function perplMarketSeedFromContract(
  perpId: bigint,
  symbol: string,
  priceDecimals: bigint,
  lotDecimals: bigint,
): MarketSeed {
  return perplMarketSeed({
    marketId: perplMarketId(perpId),
    perpId,
    base: symbol,
    priceDecimals: Number(priceDecimals),
    sizeDecimals: Number(lotDecimals),
  });
}
