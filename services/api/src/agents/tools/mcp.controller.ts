import type { ServerResponse } from 'node:http';

import { All, Controller, Req, Res } from '@nestjs/common';

import { McpHttp, type McpRequest } from './mcp-http';

/**
 * `/mcp`: the Sente MCP server over Streamable HTTP (POST, GET and DELETE).
 * The raw request and response go to the transport untouched — `@Res()` puts
 * Nest in library-specific mode, so it never writes a response of its own.
 * Auth is the agent's MCP bearer token; see `McpHttp`.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpHttp) {}

  @All()
  handle(@Req() req: McpRequest, @Res() res: ServerResponse): Promise<void> {
    return this.mcp.handle(req, res);
  }
}
