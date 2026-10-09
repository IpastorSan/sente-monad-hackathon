import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsUUID, Matches } from 'class-validator';

import { Auth } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { agentErrorToHttpBody } from '../agents.errors';
import { AgentsService } from '../agents.service';
import { AgentRunScheduler } from '../runner/agent-run.scheduler';
import type { AgentRecord } from '../store/agent-store';
import { WatcherInvalidError } from './watcher.schema';
import { WatcherService, type WatcherSetView } from './watcher.service';

class AgentIdParamDto {
  @IsUUID('4')
  id!: string;
}

class WatcherParamDto {
  @IsUUID('4')
  id!: string;

  @Matches(/^[A-Za-z0-9_-]{1,24}$/)
  wid!: string;
}

/** `GET /agents/:id/watchers`: the set, its counters, and the cadence it is checked at. */
export interface AgentWatchersResponseDto extends WatcherSetView {
  /** How often the watchers are checked; null when the agent runs only by hand (never checked). */
  readonly everySeconds: number | null;
}

/**
 * The agent's watchers (SEN-182), for its owner: read them with what they
 * have saved, delete one, or add and edit them under the same validation the
 * agent's `set_watchers` tool applies (`watcher.schema.ts`), against the
 * agent's current mandate.
 *
 * Owner-only, like every agent route: another user's agent is a 404
 * `agent_not_found`. A body that breaks a rule is a 400 with `reason`
 * `invalid_input`, `market_not_allowed` or `venue_not_allowed`. Bodies are
 * validated by zod here, not by the global ValidationPipe (they are typed
 * `unknown`, which the pipe passes through).
 */
@Controller('agents')
@UseGuards(SessionAuthGuard)
export class WatchersController {
  constructor(
    private readonly agents: AgentsService,
    private readonly auth: Auth,
    private readonly watchers: WatcherService,
    private readonly scheduler: AgentRunScheduler,
  ) {}

  @Get(':id/watchers')
  async list(@Param() params: AgentIdParamDto): Promise<AgentWatchersResponseDto> {
    return this.respond(await this.owned(params.id));
  }

  /** Replaces the whole set: `{watchers: [...], heartbeatHours?}`. */
  @Put(':id/watchers')
  async replace(
    @Param() params: AgentIdParamDto,
    @Body() body: unknown,
  ): Promise<AgentWatchersResponseDto> {
    const agent = await this.owned(params.id);
    this.valid(() => this.watchers.replace(agent, body, 'owner'));
    return this.respond(agent);
  }

  /** Adds the watcher `wid`, or replaces it: `{label, match?, clauses, cooldownMinutes?}`. */
  @Put(':id/watchers/:wid')
  async upsert(
    @Param() params: WatcherParamDto,
    @Body() body: unknown,
  ): Promise<AgentWatchersResponseDto> {
    const agent = await this.owned(params.id);
    this.valid(() => this.watchers.upsert(agent, params.wid, body, 'owner'));
    return this.respond(agent);
  }

  @Delete(':id/watchers/:wid')
  @HttpCode(HttpStatus.OK)
  async remove(@Param() params: WatcherParamDto): Promise<AgentWatchersResponseDto> {
    const agent = await this.owned(params.id);
    if (!this.watchers.remove(agent.id, params.wid)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.NOT_FOUND,
          reason: 'watcher_not_found',
          message: `this agent has no watcher ${params.wid}`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.respond(agent);
  }

  private respond(agent: AgentRecord): AgentWatchersResponseDto {
    return {
      everySeconds: this.scheduler.cadenceOf(agent)?.everySeconds ?? null,
      ...this.watchers.view(agent.id),
    };
  }

  private valid(write: () => unknown): void {
    try {
      write();
    } catch (error) {
      if (!(error instanceof WatcherInvalidError)) throw error;
      throw new HttpException(
        { statusCode: HttpStatus.BAD_REQUEST, reason: error.code, message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Ownership first. Refusals become the same `{statusCode, reason}` bodies as `AgentsController`. */
  private async owned(id: string): Promise<AgentRecord> {
    try {
      return await this.agents.get(this.auth.principal(), id);
    } catch (error) {
      const body = agentErrorToHttpBody(error);
      if (body) throw new HttpException(body, body.statusCode);
      throw error;
    }
  }
}
