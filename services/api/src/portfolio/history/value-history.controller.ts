import { Controller, Get, HttpException, Param, Query, UseGuards } from '@nestjs/common';

import { agentErrorToHttpBody } from '../../agents/agents.errors';
import { AgentsService } from '../../agents/agents.service';
import { AgentIdParamDto } from '../../agents/dto/agent.dto';
import { Auth } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { TradingEnabledGuard } from '../../trade/trade.controller';
import { HistoryQueryDto, type ValueHistoryDto } from './value-history.dto';
import { ValueHistoryService } from './value-history.service';

/**
 * `GET /portfolio/history?range=1d|1w|1m|all` (SEN-152): the caller's ≈ $
 * total over time. Gated exactly like `/portfolio` — session, then the manual
 * trading flag before the query is validated — so with the flag off it is the
 * same 404 `trading_disabled`.
 *
 * Asking is also what starts a user's recording: the registry has no list of
 * users to walk, so the first read tracks the caller and the next tick takes
 * their first point. Until then `points` is empty and the phone keeps its
 * "since you opened" line.
 */
@Controller('portfolio')
@UseGuards(SessionAuthGuard, TradingEnabledGuard)
export class PortfolioHistoryController {
  constructor(
    private readonly history: ValueHistoryService,
    private readonly auth: Auth,
  ) {}

  @Get('history')
  portfolioHistory(@Query() query: HistoryQueryDto): ValueHistoryDto {
    const { userId } = this.auth.principal();
    this.history.track(userId);
    return this.history.history('user', userId, query.range ?? '1d');
  }
}

/**
 * `GET /agents/:id/history?range=` (SEN-152): one agent's ≈ $ over time,
 * owner-scoped like `/agents/:id/portfolio` — another user's agent is a 404
 * before anything is read. Not behind the trading flag: agents trade whatever
 * the flag says, and their portfolio route is not behind it either.
 */
@Controller('agents')
@UseGuards(SessionAuthGuard)
export class AgentHistoryController {
  constructor(
    private readonly history: ValueHistoryService,
    private readonly agents: AgentsService,
    private readonly auth: Auth,
  ) {}

  @Get(':id/history')
  async agentHistory(
    @Param() params: AgentIdParamDto,
    @Query() query: HistoryQueryDto,
  ): Promise<ValueHistoryDto> {
    try {
      const agent = await this.agents.get(this.auth.principal(), params.id);
      return this.history.history('agent', agent.id, query.range ?? '1d');
    } catch (error) {
      const body = agentErrorToHttpBody(error);
      if (body) throw new HttpException(body, body.statusCode);
      throw error;
    }
  }
}
