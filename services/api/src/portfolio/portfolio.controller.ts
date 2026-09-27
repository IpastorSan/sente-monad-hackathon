import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { TradingEnabledGuard } from '../trade/trade.controller';
import { tradeRefusalToHttpException } from '../trade/trade.service';
import { FillsQueryDto, type FillsPageDto, type PortfolioDto } from './dto/portfolio.dto';
import { UserPortfolioService } from './portfolio.service';

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
      throw tradeRefusalToHttpException(error);
    }
  }
}
