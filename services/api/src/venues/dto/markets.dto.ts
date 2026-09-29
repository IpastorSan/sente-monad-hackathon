/**
 * The trading wire contract (SEN-70, plan B-T5a), pasted verbatim from
 * `docs/design/trading/plan-backend.md` § "Wire contract" with `export` added.
 * The mobile app codes against these shapes, so they change only together
 * with that section.
 *
 * The class-validator param and query DTOs for the `/markets` routes (SEN-77,
 * plan B-T6) follow the contract, at the end of the file.
 */
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';

export type Decimal = string; // exact decimal, never a float
export type VenueId = 'kuru' | 'perpl';
export type QuoteCurrency = 'USDC' | 'AUSD'; // Kuru Testnet USDC vs Agora AUSD — never interchangeable
export interface ApiError {
  statusCode: number;
  reason: string;
  message: string;
  retryAfterMs?: number;
}

// GET /markets
export interface MarketDto {
  venue: VenueId;
  symbol: string;
  venueSymbol: string;
  kind: 'spot' | 'perp';
  base: string;
  quote: QuoteCurrency;
  tickSize: Decimal;
  stepSize: Decimal;
  minSize: Decimal;
  minNotional: Decimal | null; // Kuru only (quote units)
  maxLeverage: number | null; // perps only
  marginMode: 'isolated' | null;
  makerFee: Decimal;
  takerFee: Decimal; // fractions: '0.0007' = 7 bps
}
export interface MarketsResponseDto {
  markets: MarketDto[];
  venues: { venue: VenueId; ok: boolean; error?: string }[]; // partial when a venue is down
  asOf: number;
}

// GET /markets/tickers?venue=  and  GET /markets/:venue/:symbol/ticker
export interface TickerDto {
  venue: VenueId;
  symbol: string;
  quote: QuoteCurrency;
  last: Decimal | null;
  mark: Decimal | null;
  index: Decimal | null; // mark/index: perps
  bid: Decimal | null;
  ask: Decimal | null;
  mid: Decimal | null;
  open24h: Decimal | null;
  high24h: Decimal | null;
  low24h: Decimal | null;
  change24h: Decimal | null;
  change24hPct: Decimal | null; // pct as a fraction
  quoteVolume24h: Decimal | null;
  // rate: fraction per interval, positive = longs pay shorts. Perpl fills it from /pub/context
  // (SEN-145); nextAt is an estimate there, the interval being counted in blocks. Kuru: null.
  funding: { rate: Decimal; intervalHours: number; nextAt: number | null } | null;
  stale: boolean;
  asOf: number;
}
export interface TickersResponseDto {
  tickers: TickerDto[];
  asOf: number;
}

// GET /markets/:venue/:symbol/depth?limit=20  (1..50)
export interface DepthDto {
  venue: VenueId;
  symbol: string;
  bids: { price: Decimal; size: Decimal }[]; // best first
  asks: { price: Decimal; size: Decimal }[];
  sequence: number | null;
  stale: boolean;
  asOf: number;
}

// GET /markets/:venue/:symbol/klines?interval=1h&limit=200&endTime=
export type KlineInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'; // perpl: no '1w'
export interface KlineDto {
  openTime: number;
  closeTime: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal; // base units — an estimate on both venues
  quoteVolume: Decimal | null;
}
export interface KlinesDto {
  venue: VenueId;
  symbol: string;
  interval: KlineInterval;
  klines: KlineDto[]; // oldest first
  volumeIsEstimate: true;
  asOf: number;
}

// GET /markets/:venue/:symbol/quote?side=buy&size=1.5&maxSlippage=0.005
export interface QuoteDto {
  venue: VenueId;
  symbol: string;
  side: 'buy' | 'sell';
  size: Decimal;
  fillableSize: Decimal;
  averagePrice: Decimal | null;
  notional: Decimal;
  estimatedFee: Decimal;
  feeAsset: QuoteCurrency;
  slippageVsMid: Decimal;
  maxSlippage: Decimal; // effective (Perpl clamps to venue bps)
  worstPrice: Decimal | null; // pass as slippageLimitPrice when placing
  fillableWithinWorstPrice: Decimal;
  partial: boolean; // fillableWithinWorstPrice < size → "filled 62%, rest cancelled"
  minNotionalOk: boolean | null; // Kuru only
  bookAsOf: number;
  stale: boolean;
}

// GET /agents/:id/portfolio   (owner-scoped, 404 for others)
export type SectionResult<T> = ({ ok: true } & T) | { ok: false; error: string };
export interface BalanceDto {
  asset: string;
  available: Decimal;
  locked: Decimal;
  total: Decimal;
}
export interface OrderDto {
  venue: VenueId;
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: string;
  price: Decimal | null;
  size: Decimal;
  filledSize: Decimal;
  leverage: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface PositionDto {
  symbol: string;
  side: 'long' | 'short';
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  liquidationPriceEst: Decimal | null; // our formula, excludes accrued funding — label "est."
  leverage: number;
  margin: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal | null;
  fundingPaid: Decimal | null;
  quote: 'AUSD';
  updatedAt: number;
}
export interface SpotHoldingDto {
  asset: string;
  market: string;
  amount: Decimal;
  inWallet: Decimal;
  inAccount: Decimal;
  lockedInOrders: Decimal;
  markPrice: Decimal | null;
  value: Decimal | null; // USDC
  costBasis: {
    avgPrice: Decimal | null;
    coveredSize: Decimal;
    uncoveredSize: Decimal;
    unrealizedPnl: Decimal | null;
    complete: boolean;
    source: 'event-log-fifo';
  };
  note?: string;
}
export interface AgentPortfolioDto {
  agentId: string;
  address: string;
  asOf: number;
  wallet: SectionResult<{ balances: (BalanceDto & { decimals: number })[] }>;
  kuru: SectionResult<{ accountId: string | null; balances: BalanceDto[]; openOrders: OrderDto[] }>;
  // `asOf`: when Perpl was read — it can lag the portfolio's own `asOf`,
  // since the section is cached for longer (SEN-122). `stale`: the latest read
  // failed and this is the last good one.
  perpl: SectionResult<
    (
      | {
          status: 'ok';
          accountId: string;
          balances: BalanceDto[];
          positions: PositionDto[];
          openOrders: OrderDto[];
        }
      | {
          status: 'not_enrolled';
          accountId: string;
          balances: BalanceDto[];
          positions: null;
          openOrders: null;
          // SEN-148: why the agent holds no Perpl key after a failed enrollment.
          reason?: string;
        }
      | { status: 'no_account' }
      | { status: 'not_in_mandate' }
    ) & { asOf?: number; stale?: true }
  >;
  holdings: SpotHoldingDto[];
  totals: { approxUsd: Decimal; byQuote: { USDC: Decimal; AUSD: Decimal }; note: string };
}

// Schedule
// PATCH /agents/:id/schedule  body { everySeconds: number | null } (60..86400; null = manual only) → AgentResponseDto
// AgentResponseDto += { schedule: { everySeconds: number } | null }; CreateAgentDto += { schedule?: { everySeconds: number } }
export interface AgentScheduleStatusDto {
  // GET /agents/:id/schedule
  everySeconds: number | null;
  source: 'agent' | 'global' | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  paused: {
    reason: 'credits_low' | 'credits_exhausted' | 'credits_unavailable' | 'daily_cap';
    until: string | null;
  } | null;
}

// Presets
export type ParamSpec =
  | {
      key: string;
      label: string;
      type: 'number';
      min: number;
      max: number;
      step: number;
      unit?: '%' | 'x' | 'USDC' | 'AUSD' | 'min' | 'h';
      default: number;
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: 'enum';
      options: { value: string; label: string }[];
      default: string;
      help?: string;
    }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string }
  | {
      key: string;
      label: string;
      type: 'market';
      venue: VenueId | 'any';
      multiple: boolean;
      default: string | string[];
      help?: string;
    };
export interface SuggestedMandateDto {
  tier: 'cautious' | 'standard' | 'wide'; // maps onto the app's mandate presets
  venues: VenueId[];
  kuruMarkets: string[];
  perplMarkets: string[];
  maxOrderNotional: Decimal;
  maxLeverage: number | null;
  depositCaps: { asset: string; amount: Decimal }[];
  perplCollateral: Decimal | null;
  expiryDays: number;
  softRules: string[]; // e.g. 'sell-only' — NOT enforceable by the mandate
}
export interface PresetDto {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: VenueId[];
  params: ParamSpec[];
  tools: string[];
  defaults: {
    params: Record<string, unknown>;
    strategy: string;
    systemPrompt: string;
    suggestedMandate: SuggestedMandateDto;
    suggestedCadenceSeconds: number;
  };
}
// GET /presets → { presets: PresetDto[] }
// CreateAgentDto += { preset?: { id: string; version?: number; params: Record<string, unknown> } }
// AgentResponseDto += { preset: { id; version; name; params: Record<string, unknown>; customized: boolean } | null }
// 400 'preset_invalid' carries { errors: { key: string; message: string }[] }
export interface PresetStatsDto {
  // GET /presets/:id/stats
  presetId: string;
  window: '30d';
  running: number;
  n: number;
  minN: 5;
  medianPnl30d: Decimal | null; // ≈$ (USDC+AUSD); null when n < minN
  medianReturn30d: Decimal | null;
  returnN: number;
  customized: number;
  definition: string;
  notes: string[];
  asOf: number;
}

// ---------------------------------------------------------------------------
// `/markets` params and queries (SEN-77, plan B-T6). Query values arrive as
// strings, so numeric ones carry `@Type(() => Number)` for the global pipe's
// `transform` step.

export const VENUE_IDS: readonly VenueId[] = ['kuru', 'perpl'];
export const KLINE_INTERVALS: readonly KlineInterval[] = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
  '1w',
];

export const DEPTH_DEFAULT_LIMIT = 20;
export const DEPTH_MAX_LIMIT = 50;
export const KLINES_DEFAULT_LIMIT = 200;
export const KLINES_MAX_LIMIT = 1000;
export const QUOTE_DEFAULT_MAX_SLIPPAGE: Decimal = '0.005';
export const QUOTE_MAX_SLIPPAGE: Decimal = '0.05';

/** `:venue/:symbol`. The symbol ends up in cache keys and logs, so it is bounded here. */
export class MarketParamsDto {
  @IsIn(VENUE_IDS)
  venue!: VenueId;

  @Matches(/^[A-Za-z0-9._-]{1,32}$/, { message: 'symbol must be 1-32 of [A-Za-z0-9._-]' })
  symbol!: string;
}

export class TickersQueryDto {
  @IsOptional()
  @IsIn(VENUE_IDS)
  venue?: VenueId;
}

export class DepthQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DEPTH_MAX_LIMIT)
  limit?: number;
}

export class KlinesQueryDto {
  /**
   * Checked against every interval either venue serves. One that exists but
   * not on this venue (Perpl `1w`) passes here and is the service's 400
   * `interval_not_supported`.
   */
  @IsIn(KLINE_INTERVALS)
  interval!: KlineInterval;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KLINES_MAX_LIMIT)
  limit?: number;

  /** Unix ms, exclusive. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endTime?: number;
}

export class QuoteQueryDto {
  @IsIn(['buy', 'sell'])
  side!: 'buy' | 'sell';

  /**
   * Only bounded here. The controller checks its shape, so a malformed size
   * answers the same 400 `invalid_size` as one the venue cannot represent:
   * that reason is what the app branches on (`apps/mobile/src/markets/hooks.ts`).
   */
  @IsString()
  @MaxLength(64)
  size!: string;

  @IsOptional()
  @IsDecimalAtMost(QUOTE_MAX_SLIPPAGE)
  maxSlippage?: Decimal;
}

/** Up to 18 places: the precision the service compares decimals at. */
export const UNSIGNED_DECIMAL = /^\d+(\.\d{1,18})?$/;

/** Compared exactly: as floats, `'0.0500000000000000001'` would pass for 0.05. */
function IsDecimalAtMost(max: Decimal): PropertyDecorator {
  return ValidateBy({
    name: 'isDecimalAtMost',
    constraints: [max],
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && UNSIGNED_DECIMAL.test(value) && x18(value) <= x18(max),
      defaultMessage: (args) => `${args?.property ?? 'value'} must be a decimal from 0 to ${max}`,
    },
  });
}

function x18(value: Decimal): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}
