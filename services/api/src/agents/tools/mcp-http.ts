/**
 * `/mcp` over Streamable HTTP, with one MCP session per client.
 *
 * Sessions are stateful because the gate is: a thesis recorded in one call has
 * to be there for the order in the next, and each call is its own HTTP request.
 * A session's run id is `mcp-<session id>`.
 *
 * Every request is authenticated, not just the first: `Authorization: Bearer
 * <agent MCP token>` must resolve to an ACTIVE agent, and a session only
 * answers the agent that opened it. So revoking an agent cuts off its open
 * sessions at their next request — a wrong token and a revoked agent's token
 * are the same 401.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { AgentRecord } from '../store/agent-store';
import type { ToolContext } from './context';
import { createMcpServer } from './mcp';

export interface McpHttpOptions {
  /** The active agent a raw bearer token belongs to — `AgentsService.findByMcpToken`. */
  readonly authenticate: (token: string) => Promise<AgentRecord | undefined>;
  readonly contextFor: (agent: AgentRecord, runId: string) => ToolContext;
  /** Close a session after this long without a request. Default 30 min. */
  readonly idleMs?: number;
  /** Opening one more closes the agent's least recently used. Default 4. */
  readonly maxSessionsPerAgent?: number;
}

/** A request after Nest's JSON body parser. */
export type McpRequest = IncomingMessage & { body?: unknown };

interface Session {
  readonly id: string;
  readonly agentId: string;
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export const MCP_IDLE_MS = 30 * 60_000;
const BEARER = /^Bearer\s+(\S+)\s*$/i;

export class McpHttp {
  private readonly logger = new Logger('McpHttp');
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly maxSessionsPerAgent: number;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly options: McpHttpOptions) {
    this.idleMs = options.idleMs ?? MCP_IDLE_MS;
    this.maxSessionsPerAgent = options.maxSessionsPerAgent ?? 4;
    this.sweeper = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.sweeper.unref?.();
  }

  /** Open sessions. */
  get size(): number {
    return this.sessions.size;
  }

  async handle(req: McpRequest, res: ServerResponse): Promise<void> {
    try {
      const agent = await this.authenticate(req);
      if (!agent) return unauthorized(res);

      const sessionId = header(req, 'mcp-session-id');
      if (sessionId !== undefined) {
        const session = this.sessions.get(sessionId);
        // Another agent's session id is "not found", never "forbidden".
        if (!session || session.agentId !== agent.id) {
          return jsonRpcError(res, 404, -32001, 'Session not found: start a new MCP session');
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, -32000, 'Bad Request: no valid Mcp-Session-Id header');
      }
      await this.open(agent, req, res);
    } catch (error) {
      // Message only: a stack or a request body has no business in the log line.
      this.logger.error(`MCP request failed: ${error instanceof Error ? error.message : 'error'}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    }
  }

  /** Close every session — shutdown, or a test's teardown. */
  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => this.closeSession(s)));
  }

  /** Nest lifecycle hook. */
  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  private async authenticate(req: McpRequest): Promise<AgentRecord | undefined> {
    const token = BEARER.exec(header(req, 'authorization') ?? '')?.[1];
    return token === undefined ? undefined : this.options.authenticate(token);
  }

  private async open(agent: AgentRecord, req: McpRequest, res: ServerResponse): Promise<void> {
    await this.evictOverflow(agent.id);
    const id = randomUUID();
    const server = createMcpServer(this.options.contextFor(agent, `mcp-${id}`));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        this.sessions.set(id, session);
      },
    });
    const session: Session = { id, agentId: agent.id, server, transport, lastSeen: Date.now() };
    transport.onclose = () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // An initialize the transport refused never became a session.
    if (!this.sessions.has(id)) await server.close();
  }

  private async evictOverflow(agentId: string): Promise<void> {
    const mine = [...this.sessions.values()]
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    const excess = mine.length - (this.maxSessionsPerAgent - 1);
    await Promise.all(mine.slice(0, Math.max(0, excess)).map((s) => this.closeSession(s)));
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleMs;
    for (const session of this.sessions.values()) {
      if (session.lastSeen < cutoff) void this.closeSession(session);
    }
  }

  private async closeSession(session: Session): Promise<void> {
    this.sessions.delete(session.id);
    await session.server.close().catch(() => undefined);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="sente-mcp", error="invalid_token"',
  });
  res.end(
    JSON.stringify({
      statusCode: 401,
      reason: 'unauthorized',
      message: 'a valid MCP token for an active agent is required: Authorization: Bearer <token>',
    }),
  );
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
