import { Controller, Get, HttpException, HttpStatus, Query, UseGuards } from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { TradingEnabledGuard } from '../trade/trade.controller';
import { tradeRefusalToHttpException } from '../trade/trade.service';
import { FillsQueryDto, type FillsPageDto, type PortfolioDto } from './dto/portfolio.dto';
import {
  PortfolioRefusedError,
  UserPortfolioService,
  type PortfolioRefusalReason,
} from './portfolio.service';

const REFUSAL_STATUS: Record<PortfolioRefusalReason, HttpStatus> = {
  invalid_cursor: HttpStatus.BAD_REQUEST,
  // 409: the account exists or may, but this server holds no read key for it
  // (SEN-151). Not an empty page, which would read as "no fills".
  perpl_unlinked: HttpStatus.CONFLICT,
  perpl_unavailable: HttpStatus.BAD_GATEWAY,
};

/**
 * The caller's own portfolio (SEN-101, plan-trading M-T19). Identity is the
 * session subject; nothing in the query names a user.
 *
 * Behind the manual-trading flag with `/trade`'s own guard, so with it off
 * both answer the same 404 `trading_disabled` (plan §5) — and before the
 * query is validated, so a bad `cursor` does not describe a route that is
 * meant to look absent.
 */
@Controller('portfolio')
@UseGuards(SessionAuthGuard, TradingEnabledGuard)
export class PortfolioController {
  constructor(
    private readonly portfolios: UserPortfolioService,
    private readonly auth: Auth,
  ) {}

  @Get()
  async portfolio(): Promise<PortfolioDto> {
    return this.guard(() => this.portfolios.portfolio(this.auth.principal()));
  }

  @Get('fills')
  async fills(@Query() query: FillsQueryDto): Promise<FillsPageDto> {
    return this.guard(() => this.portfolios.fills(this.auth.principal(), query));
  }

  /** `account_not_registered` and friends become their clean 4xx; the rest fall through. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PortfolioRefusedError) {
        const statusCode = REFUSAL_STATUS[error.reason];
        throw new HttpException(
          { statusCode, reason: error.reason, message: error.message },
          statusCode,
        );
      }
      throw tradeRefusalToHttpException(error);
    }
  }
}
