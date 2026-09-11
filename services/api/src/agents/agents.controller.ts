import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { GasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import { agentErrorToHttpBody } from './agents.errors';
import { AgentsService } from './agents.service';
import {
  AgentIdParamDto,
  AmendMandateDto,
  CreateAgentDto,
  toAgentResponse,
  type AgentListResponseDto,
  type AgentResponseDto,
  type HireAgentResponseDto,
} from './dto/agent.dto';

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

  /** Refusals become a clean 4xx/5xx with a stable `reason`; the rest fall through. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const body = agentErrorToHttpBody(error);
      throw body ? new HttpException(body, body.statusCode) : error;
    }
  }
}
