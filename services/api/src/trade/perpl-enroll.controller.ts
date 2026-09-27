import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PerplEnrollCommitDto, PerplEnrollPrepareDto } from './dto/perpl-enroll.dto';
import {
  enrollRefusalToHttpException,
  PerplEnrollService,
  type EnrollCommitResult,
  type EnrollPrepareResult,
} from './perpl-enroll.service';
import { TradingEnabledGuard } from './trade.controller';

/**
 * Perpl key enrollment for the user's wallet (SEN-100, plan M-T18).
 *
 * Its own controller under `/trade` rather than two more methods on
 * `TradeController`, so it stays a self-contained unit beside the routes other
 * tasks are adding there. Same guards: session, then the trade flag (404
 * `trading_disabled` before the body is even validated).
 */
@Controller('trade/perpl/enroll')
@UseGuards(SessionAuthGuard, TradingEnabledGuard)
export class PerplEnrollController {
  constructor(
    private readonly enroll: PerplEnrollService,
    private readonly auth: Auth,
  ) {}

  /** Fetches both Perpl payloads and composes what the device key signs. Signs nothing. */
  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  async prepare(@Body() body: PerplEnrollPrepareDto): Promise<EnrollPrepareResult> {
    return this.guard(() => this.enroll.prepare(this.auth.principal(), body));
  }

  /** Forwards the device signatures, enrolls both keys. Single-use: a replay is 404. */
  @Post('commit')
  @HttpCode(HttpStatus.OK)
  async commit(@Body() body: PerplEnrollCommitDto): Promise<EnrollCommitResult> {
    return this.guard(() => this.enroll.commit(this.auth.principal(), body));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw enrollRefusalToHttpException(error);
    }
  }
}
