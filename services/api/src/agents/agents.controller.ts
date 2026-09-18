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
import { ConsensusService } from '../chain/consensus.service';
import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { agentErrorStatus, agentErrorToHttpBody } from './agents.errors';
import { AgentsService } from './agents.service';
import {
  AgentEventsQueryDto,
  AgentIdParamDto,
  AGENT_EVENTS_DEFAULT_LIMIT,
  AmendMandateDto,
  CreateAgentDto,
  ForkAgentDto,
  RunAgentDto,
  toAgentEventResponse,
  toAgentResponse,
  type AgentEventResponseDto,
  type AgentEventsResponseDto,
  type AgentListResponseDto,
  type AgentResponseDto,
  type HireAgentResponseDto,
} from './dto/agent.dto';
import { AGENT_EVENTS, type AgentEventLog } from './events/agent-event-log';
import { AgentRunnerService, type RunResult } from './runner/agent-runner.service';

/**
 * AUTH: the seam `wallet/` and `gas/` use — `SessionAuthGuard` (SEN-37) puts a
 * principal on the request from a verified session token, whose `sub` is the
 * caller's lowercase EOA address. That is the same string `AgentRecord.userId`
 * has always held, so nothing an agent owns had to be migrated.
 *
 * Every route is scoped to that principal; no body or param names a user.
 */
@Controller('agents')
@UseGuards(SessionAuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly auth: Auth,
    private readonly runner: AgentRunnerService,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
    /**
     * SEN-21: only `GET /agents/:id/events` uses this, to say how far Monad has
     * taken the block an order or fill confirmed in. `ChainModule` provides it;
     * see `agents.module.ts`.
     */
    private readonly consensus: ConsensusService,
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
        ...(body.public !== undefined ? { public: body.public } : {}),
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
   *
   * SEN-21, widened in SEN-35: every event that carries a `blockNumber` —
   * `order`, `fill`, `close` and the `verdict` a fill settled (SEN-47) — also
   * carries `consensus`, so the Ledger's ramp can show how far Monad has taken
   * that block without asking a second route per row. See `withConsensus`.
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
        events: events.map(toAgentEventResponse).map((event) => this.withConsensus(event)),
        nextSeq: events.at(-1)?.seq ?? query.afterSeq ?? 0,
      };
    });
  }

  /**
   * Adds `consensus` to every event that NAMES a block, and leaves every other
   * event, and `detail` itself, exactly as the log stored it.
   *
   * Naming a block is the whole condition — deliberately, since SEN-35. SEN-21
   * kept a hand-written list of kinds (`order` and `fill`) beside a check that
   * already answers the question generally, and SEN-20's `close` was added to
   * the log without being added to the list, so closing a position was the one
   * trade whose row had no ramp. SEN-47 proved the point from the other side: a
   * `verdict` started naming the block of the fill that settled it, and got its
   * ramp here with no change at all. A thesis, a refusal and a run summary name
   * no block, so they are still untouched.
   *
   * This is the ONLY consensus path to the Ledger: the mobile ramp reads the
   * state off the event it is drawn under and only asks
   * `GET /chain/blocks/:n/consensus` while that state is not yet final. A
   * screenful of settled trades therefore costs no consensus requests at all.
   *
   * `state` is `unknown` with an empty `at` when the block is outside the
   * window `ConsensusService` keeps. That is the ordinary outcome for a trade
   * older than a few minutes, and it is a state the Ledger can draw: an
   * incomplete ramp, not a missing field.
   */
  private withConsensus(event: AgentEventResponseDto): AgentEventResponseDto {
    const blockNumber = eventBlockNumber(event.detail);
    if (blockNumber === undefined) return event;
    const record = this.consensus.stateOf(blockNumber);
    return {
      ...event,
      consensus: record
        ? { state: record.state, at: { ...record.at } }
        : { state: 'unknown', at: {} },
    };
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

  /**
   * Forks an agent's strategy into a NEW agent for the caller (SEN-28): the
   * honest way to copy a leaderboard agent is to hire its strategy, never to
   * mirror a stranger's wallet.
   *
   * - The copy takes the source's `model` and `strategy`, and its
   *   `systemPrompt` only when the source's owner published it (`public`).
   * - Its wallet and policy are new, and the policy is compiled from the
   *   mandate in THIS body — the forker's, never the source's.
   * - The response is a `HireAgentResponseDto`: the new agent, and its own MCP
   *   token, this once.
   *
   * The source is not ownership-checked — forking anyone's active agent is the
   * feature — so the only refusals are 404 `agent_not_found`, 409
   * `agent_revoked` (a revoked strategy is not running), 400 `mandate_invalid`
   * (the forker's own) and the wallet failures.
   */
  @Post(':id/fork')
  @HttpCode(HttpStatus.CREATED)
  async fork(
    @Param() params: AgentIdParamDto,
    @Body() body: ForkAgentDto,
  ): Promise<HireAgentResponseDto> {
    return this.guard(async () => {
      const { agent, mcpToken } = await this.agents.fork(this.auth.principal(), params.id, {
        mandate: body.mandate,
        ...(body.name !== undefined ? { name: body.name } : {}),
      });
      return { agent: toAgentResponse(agent), mcpToken };
    });
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

/**
 * The block an event's `detail` names, if it names one. Venue adapters record
 * `blockNumber` as a number; a decimal string is accepted too, because a
 * bigint that crossed the log's `toJsonSafe` arrives as one.
 */
function eventBlockNumber(detail: Record<string, unknown>): number | undefined {
  const value = detail['blockNumber'];
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
