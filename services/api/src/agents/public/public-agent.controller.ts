import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  Param,
} from '@nestjs/common';

import { IpRateLimiter } from '../../gas/rate-limit/ip-rate-limiter';
import type { PublicAgentDto } from './public-agent.dto';
import { PublicAgentService } from './public-agent.service';

/** Per client IP. A page load is one request, so this is generous for people and tight for loops. */
export const PUBLIC_AGENT_RATE_MAX = 60;
export const PUBLIC_AGENT_RATE_WINDOW_MS = 60_000;
/** DI token for the route's own per-IP limiter (not the drip's). */
export const PUBLIC_AGENT_RATE_LIMITER = Symbol('PUBLIC_AGENT_RATE_LIMITER');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /public/agents/:id` (SEN-193): the public agent page, no session.
 *
 * NO GUARD, deliberately — the one agent route without one. What it
 * may answer is fixed by `public-agent.dto.ts#toPublicAgent`, an allowlist,
 * not by who is asking. An unknown or malformed id is the same 404, so the
 * route says nothing about which ids exist beyond the pages it serves.
 *
 * Behind Caddy `@Ip()` is the client only with `TRUST_PROXY_HOPS` set
 * (`main.ts`); without it every caller shares one bucket, which fails closed.
 */
@Controller('public/agents')
export class PublicAgentController {
  constructor(
    private readonly agents: PublicAgentService,
    @Inject(PUBLIC_AGENT_RATE_LIMITER) private readonly limiter: IpRateLimiter,
  ) {}

  @Get(':id')
  @Header('Cache-Control', 'public, max-age=15')
  async get(@Param('id') id: string, @Ip() ip: string): Promise<PublicAgentDto> {
    if (!this.limiter.hit(ip || 'unknown')) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          reason: 'rate_limited',
          message: 'Too many requests; try again in a minute',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const agent = ID.test(id) ? await this.agents.get(id.toLowerCase()) : null;
    if (!agent) {
      throw new HttpException(
        { statusCode: HttpStatus.NOT_FOUND, reason: 'agent_not_found', message: 'No such agent' },
        HttpStatus.NOT_FOUND,
      );
    }
    return agent;
  }
}
