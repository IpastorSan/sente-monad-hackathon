import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';

import { Auth } from '../../../auth/principal';
import { SessionAuthGuard } from '../../../auth/session-auth.guard';
import { agentErrorToHttpBody } from '../../agents.errors';
import { AgentsService } from '../../agents.service';
import type { RunTranscriptSummary, TranscriptEntry } from './run-transcript';
import { RUN_TRANSCRIPTS, type RunTranscriptStore } from './run-transcript-store';

export class AgentRunParamDto {
  @IsUUID('4')
  id!: string;

  /** `run-<uuid>`, as the runner names runs. */
  @Matches(/^run-[0-9a-f-]{36}$/)
  runId!: string;
}

export class AgentRunQueryDto {
  /** Entry cursor: only entries with `seq > after` come back. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;
}

class AgentIdOnlyParamDto {
  @IsUUID('4')
  id!: string;
}

export interface AgentRunsResponseDto {
  /** Newest first: the agent's last runs this server still holds. */
  readonly runs: RunTranscriptSummary[];
}

export interface AgentRunTranscriptResponseDto {
  readonly run: RunTranscriptSummary;
  readonly entries: readonly TranscriptEntry[];
  /** Pass back as `after` to read what comes next. */
  readonly nextSeq: number;
}

/**
 * The run transcripts (SEN-178): what an agent saw, said, thought and did, run
 * by run — the agent page's terminal.
 *
 * Owner-only, like every agent route: the agent is read through
 * `AgentsService.get` first, so another user's agent is a 404
 * `agent_not_found` and never an empty list. A run of a DIFFERENT agent named
 * under this one's id is a 404 `run_not_found`, the same as one that was never
 * held.
 *
 * PERSISTENCE: the last 10 runs per agent; on disk under STATE_DIR
 * (`agent-runs.jsonl`), else in memory and gone on restart.
 */
@Controller('agents')
@UseGuards(SessionAuthGuard)
export class AgentRunsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly auth: Auth,
    @Inject(RUN_TRANSCRIPTS) private readonly transcripts: RunTranscriptStore,
  ) {}

  @Get(':id/runs')
  async list(@Param() params: AgentIdOnlyParamDto): Promise<AgentRunsResponseDto> {
    await this.owned(params.id);
    return { runs: this.transcripts.list(params.id) };
  }

  /**
   * One run's summary and its entries after `after` (all of them without it).
   * Poll with the returned `nextSeq` while `run.status` is `running`.
   */
  @Get(':id/runs/:runId')
  async read(
    @Param() params: AgentRunParamDto,
    @Query() query: AgentRunQueryDto,
  ): Promise<AgentRunTranscriptResponseDto> {
    await this.owned(params.id);
    const after = query.after ?? 0;
    const page = this.transcripts.read(params.id, params.runId, after);
    if (!page) {
      throw new HttpException(
        {
          statusCode: HttpStatus.NOT_FOUND,
          reason: 'run_not_found',
          message: `no transcript for ${params.runId} on this agent (only the last runs are kept)`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      run: page.run,
      entries: page.entries,
      nextSeq: page.entries.at(-1)?.seq ?? Math.min(after, page.run.lastSeq),
    };
  }

  /** Ownership first. Refusals become the same `{statusCode, reason}` bodies as `AgentsController`. */
  private async owned(id: string): Promise<void> {
    try {
      await this.agents.get(this.auth.principal(), id);
    } catch (error) {
      const body = agentErrorToHttpBody(error);
      if (body) throw new HttpException(body, body.statusCode);
      throw error;
    }
  }
}
