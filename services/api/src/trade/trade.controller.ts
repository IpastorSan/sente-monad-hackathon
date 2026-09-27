import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import {
  CommitTradeDto,
  ListTradesQueryDto,
  TradeIdParamDto,
  TradeIntentDto,
  type PerplAccountDto,
  type PreparedTradeDto,
  type TradeCapabilitiesDto,
  type TradeViewDto,
} from './dto/trade.dto';
import { TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeRefusedError, TradeService, tradeRefusalToHttpException } from './trade.service';

/**
 * 404 `trading_disabled` while `USER_TRADING` is off (plan §5, SEN-96).
 *
 * A guard rather than only the service's own check, because guards run before
 * the ValidationPipe: with the flag off a malformed body must still read as
 * "this route is not here", not as a 400 that describes the route.
 */
@Injectable()
export class TradingEnabledGuard implements CanActivate {
  constructor(@Inject(TRADE_CONFIG) private readonly config: TradeConfig) {}

  canActivate(): boolean {
    if (this.config.enabled) return true;
    throw tradeRefusalToHttpException(
      new TradeRefusedError('trading_disabled', 'Manual trading is not enabled here'),
    );
  }
}

/**
 * The user's own trades (SEN-96, plan M-T14, "Architecture §4"). Identity is
 * always the session subject; nothing in a body or query names a user.
 *
 * prepare -> the phone verifies and signs every step -> commit -> poll the
 * trade. The server composes and forwards; it never signs.
 */
@Controller('trade')
@UseGuards(SessionAuthGuard)
export class TradeController {
  constructor(
    private readonly trades: TradeService,
    private readonly auth: Auth,
  ) {}

  /**
   * Whether the app may offer trading at all. The one route that answers with
   * the flag off. Declared before `:tradeId` so it is not read as an id.
   */
  @Get('capabilities')
  capabilities(): TradeCapabilitiesDto {
    return this.trades.capabilities();
  }

  /**
   * The caller's Perpl account and what onboarding still needs (SEN-99).
   * Declared before `:tradeId`, like `capabilities`, so `perpl` is not an id.
   */
  @Get('perpl/account')
  @UseGuards(TradingEnabledGuard)
  async perplAccount(): Promise<PerplAccountDto> {
    return this.guard(() => this.trades.perplAccount(this.auth.principal()));
  }

  /** Composes the trade's steps for the device key. Sends nothing. */
  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TradingEnabledGuard)
  async prepare(@Body() body: TradeIntentDto): Promise<PreparedTradeDto> {
    return this.guard(() => this.trades.prepare(this.auth.principal(), body));
  }

  /** Starts sending the signed steps and answers at once; poll `GET /trade/:tradeId`. */
  @Post(':tradeId/commit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TradingEnabledGuard)
  async commit(
    @Param() params: TradeIdParamDto,
    @Body() body: CommitTradeDto,
  ): Promise<TradeViewDto> {
    return this.guard(() =>
      this.trades.commit(this.auth.principal(), params.tradeId, body.signatures),
    );
  }

  /** The caller's newest trades, newest first. In memory: a restart forgets them. */
  @Get()
  @UseGuards(TradingEnabledGuard)
  async list(@Query() query: ListTradesQueryDto): Promise<TradeViewDto[]> {
    return this.guard(() => this.trades.list(this.auth.principal(), query.limit));
  }

  @Get(':tradeId')
  @UseGuards(TradingEnabledGuard)
  async status(@Param() params: TradeIdParamDto): Promise<TradeViewDto> {
    return this.guard(() => this.trades.status(this.auth.principal(), params.tradeId));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw tradeRefusalToHttpException(error);
    }
  }
}
