import { Controller, Get, HttpException, Param, Query, UseGuards } from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import {
  DEPTH_DEFAULT_LIMIT,
  DepthQueryDto,
  KLINES_DEFAULT_LIMIT,
  KlinesQueryDto,
  MarketParamsDto,
  QUOTE_DEFAULT_MAX_SLIPPAGE,
  QuoteQueryDto,
  TickersQueryDto,
  UNSIGNED_DECIMAL,
  type ApiError,
  type DepthDto,
  type KlinesDto,
  type MarketsResponseDto,
  type QuoteDto,
  type TickerDto,
  type TickersResponseDto,
} from './dto/markets.dto';
import {
  InvalidSizeError,
  isMarketDataError,
  MarketDataService,
  type MarketDataError,
} from './market-data.service';

const STATUS: Record<MarketDataError['reason'], number> = {
  market_not_found: 404,
  interval_not_supported: 400,
  invalid_size: 400,
  venue_unavailable: 503,
};

/** The `{statusCode, reason, message}` body the app's `MarketsApiError` reads. */
export function marketDataErrorToHttpBody(error: unknown): ApiError | undefined {
  if (!isMarketDataError(error)) return undefined;
  return {
    statusCode: STATUS[error.reason],
    reason: error.reason,
    message: error.message,
    ...('retryAfterMs' in error ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

/**
 * The phone's market-data reads (SEN-77, plan B-T6), all through the one
 * cached `MarketDataService`. Signed in only: the data is public, but every
 * request can cost a venue call, and Perpl rate-limits us, not the caller.
 *
 * `tickers` cannot collide with `:venue/:symbol/…`: those have more segments.
 */
@Controller('markets')
@UseGuards(SessionAuthGuard)
export class MarketsController {
  constructor(private readonly marketData: MarketDataService) {}

  @Get()
  markets(): Promise<MarketsResponseDto> {
    return this.guard(() => this.marketData.markets());
  }

  @Get('tickers')
  tickers(@Query() query: TickersQueryDto): Promise<TickersResponseDto> {
    return this.guard(() => this.marketData.tickers(query.venue));
  }

  @Get(':venue/:symbol/ticker')
  ticker(@Param() { venue, symbol }: MarketParamsDto): Promise<TickerDto> {
    return this.guard(() => this.marketData.ticker(venue, symbol));
  }

  @Get(':venue/:symbol/depth')
  depth(
    @Param() { venue, symbol }: MarketParamsDto,
    @Query() query: DepthQueryDto,
  ): Promise<DepthDto> {
    return this.guard(() =>
      this.marketData.depth(venue, symbol, query.limit ?? DEPTH_DEFAULT_LIMIT),
    );
  }

  @Get(':venue/:symbol/klines')
  klines(
    @Param() { venue, symbol }: MarketParamsDto,
    @Query() query: KlinesQueryDto,
  ): Promise<KlinesDto> {
    return this.guard(() =>
      this.marketData.klines(
        venue,
        symbol,
        query.interval,
        query.limit ?? KLINES_DEFAULT_LIMIT,
        query.endTime,
      ),
    );
  }

  /** A read, never an order: nothing here is signed or sent. */
  @Get(':venue/:symbol/quote')
  quote(
    @Param() { venue, symbol }: MarketParamsDto,
    @Query() query: QuoteQueryDto,
  ): Promise<QuoteDto> {
    return this.guard(async () => {
      if (!UNSIGNED_DECIMAL.test(query.size)) {
        throw new InvalidSizeError(`size must be a positive decimal, got '${query.size}'`);
      }
      return this.marketData.quote(venue, symbol, {
        side: query.side,
        size: query.size,
        maxSlippage: query.maxSlippage ?? QUOTE_DEFAULT_MAX_SLIPPAGE,
      });
    });
  }

  /** Typed market-data errors become their status; anything else stays a 500. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const body = marketDataErrorToHttpBody(error);
      if (body) throw new HttpException(body, body.statusCode);
      throw error;
    }
  }
}
