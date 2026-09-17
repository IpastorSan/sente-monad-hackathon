import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { creditsRefusalToHttpException } from '../credits/credits.errors';
import { GasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import { agentErrorStatus, agentErrorToHttpBody } from './agents.errors';
import { AgentsService } from './agents.service';
import {
  AgentEventsQueryDto,
  AgentIdParamDto,
  AGENT_EVENTS_DEFAULT_LIMIT,
  AmendMandateDto,
  CreateAgentDto,
  RunAgentDto,
  toAgentEventResponse,
  toAgentResponse,
  type AgentEventsResponseDto,
  type AgentListResponseDto,
  type AgentResponseDto,
  type HireAgentResponseDto,
} from './dto/agent.dto';
import { AGENT_EVENTS, type AgentEventLog } from './events/agent-event-log';
import { AgentRunnerService, type RunResult } from './runner/agent-runner.service';

/**
 * AUTH: the placeholder seam `wallet/` and `gas/` already use —
 * `PlaceholderGasDripAuthGuard` puts a principal on the request from
 * `x-sente-user-id` and refuses to run under NODE_ENV=production. MOV-251's
 * real session guard replaces it in the module.
 *
 * Every route is scoped to that principal; no body or param names a user.
 */
@Controller('agents')
@UseGuards(PlaceholderGasDripAuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly auth: GasDripAuth,
    private readonly runner: AgentRunnerService,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
  ) {}

  /** Hire: the response is the ONLY time the MCP token is ever returned. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async hire(@Body() body: CreateAgentDto): Promise<HireAgentResponseDto> {
    return this.guard(async () => {
      const { agent, mcpToken } = await this.agents.hire(this.auth.principal(), {
        name: body.name,
        systemPrompt: body.systemPrompt,
        strategy: body.strategy,
        model: body.model,
        mandate: body.mandate,
      });
      return { agent: toAgentResponse(agent), mcpToken };
    });
  }

  @Get()
  async list(): Promise<AgentListResponseDto> {
    return this.guard(async () => ({
      agents: (await this.agents.list(this.auth.principal())).map(toAgentResponse),
    }));
  }

  @Get(':id')
  async get(@Param() params: AgentIdParamDto): Promise<AgentResponseDto> {
    return this.guard(async () =>
      toAgentResponse(await this.agents.get(this.auth.principal(), params.id)),
    );
  }

  /**
   * The agent's event log — every thesis, order, fill, close and refusal its
   * tools produced (SEN-20). This is what the Agent Ledger reads, so the
   * field names in `detail` are wire-stable; bigints cross as decimal strings.
   *
   * PERSISTENCE: in memory, 10k events per agent, oldest dropped first (see
   * `events/agent-event-log.ts`). Paging forward with `afterSeq` is stable
   * until that cap drops events behind the cursor.
   *
   * `nextSeq` is the highest `seq` in the page: pass it back as `afterSeq` to
   * read what comes next. Oldest-first within the page.
   */
  @Get(':id/events')
  async listEvents(
    @Param() params: AgentIdParamDto,
    @Query() query: AgentEventsQueryDto,
  ): Promise<AgentEventsResponseDto> {
    return this.guard(async () => {
      // Ownership first: another user's agent is a 404, not an empty log.
      await this.agents.get(this.auth.principal(), params.id);
      const events = await this.events.list(params.id, {
        afterSeq: query.afterSeq,
        kind: query.kind,
        limit: query.limit ?? AGENT_EVENTS_DEFAULT_LIMIT,
      });
      return {
        events: events.map(toAgentEventResponse),
        nextSeq: events.at(-1)?.seq ?? query.afterSeq ?? 0,
      };
    });
  }

  @Patch(':id/mandate')
  async amendMandate(
    @Param() params: AgentIdParamDto,
    @Body() body: AmendMandateDto,
  ): Promise<AgentResponseDto> {
    return this.guard(async () =>
      toAgentResponse(
        await this.agents.amendMandate(this.auth.principal(), params.id, body.mandate),
      ),
    );
  }

  /** Permanent. Retrying is safe, and is how a failed policy clear is retried. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Param() params: AgentIdParamDto): Promise<AgentResponseDto> {
    return this.guard(async () =>
      toAgentResponse(await this.agents.revoke(this.auth.principal(), params.id)),
    );
  }

  /**
   * Runs the agent once, now, and answers with the whole run (SEN-8).
   *
   * - 200 with the `RunResult` for every run that ended on its own terms,
   *   including `refusal`, `max_tokens`, `max_iterations`, `timeout` and
   *   `agent_revoked` (revoked mid-run): the stop reason says which.
   * - 402 `credits_exhausted` and 502 `model_error`, each with the run in `run`.
   * - Refused before anything is spent: 404 `agent_not_found`, 409
   *   `agent_revoked`, 409 `run_in_progress`, 503 `credits_unconfigured`,
   *   502 `provision_failed`.
   */
  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(@Param() params: AgentIdParamDto, @Body() body: RunAgentDto): Promise<RunResult> {
    const result = await this.guard(() =>
      this.runner.run(this.auth.principal(), params.id, {
        instruction: body.instruction,
        trigger: 'manual',
      }),
    );
    if (result.stopReason === 'credits_exhausted' || result.stopReason === 'model_error') {
      const statusCode = agentErrorStatus(result.stopReason);
      throw new HttpException(
        {
          statusCode,
          reason: result.stopReason,
          message:
            result.stopReason === 'credits_exhausted'
              ? 'Your inference credits are used up for this month (OpenRouter 402)'
              : `The model call failed: ${result.error ?? 'unknown error'}`,
          run: result,
        },
        statusCode,
      );
    }
    return result;
  }

  /** Refusals become a clean 4xx/5xx with a stable `reason`; the rest fall through. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const body = agentErrorToHttpBody(error);
      if (body) throw new HttpException(body, body.statusCode);
      throw creditsRefusalToHttpException(error);
    }
  }
}
