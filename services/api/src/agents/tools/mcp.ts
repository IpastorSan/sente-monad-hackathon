/**
 * The gated tools as an MCP server, for "bring your own agent": an external
 * client (Claude Desktop, any MCP host) trades for ONE agent, bounded by the
 * same gate and the same enclave policy as our own runner.
 *
 * The server is built per session around a `ToolContext`, so a session can
 * only ever act as the agent its bearer token belongs to. A refusal comes back
 * as an `isError: true` result, never as a protocol error.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolContext } from './context';
import { GATED_TOOLS, toResultText, type GatedTool, type ToolOutcome } from './gate';

export const SENTE_MCP_INSTRUCTIONS =
  'You trade for one Sente agent, bounded by its mandate. Call get_mandate first. Before any ' +
  'order or deposit on a market, call record_thesis for it. Refusals are final: a request ' +
  'refused by the Sente mandate or by the Privy enclave will be refused again if repeated.';

export function createMcpServer(
  ctx: ToolContext,
  tools: readonly GatedTool[] = GATED_TOOLS,
): McpServer {
  const server = new McpServer(
    { name: 'sente', version: '0.1.0' },
    { instructions: SENTE_MCP_INSTRUCTIONS },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.kind === 'read', openWorldHint: true },
      },
      async (args: unknown) => toCallToolResult(await tool.invoke(ctx, args)),
    );
  }
  return server;
}

export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  return outcome.ok
    ? { content: [{ type: 'text', text: toResultText(outcome.result) }] }
    : { isError: true, content: [{ type: 'text', text: outcome.message }] };
}
