/**
 * `/mcp` through a real Nest HTTP server. The protocol is spoken with plain
 * `fetch` rather than the SDK's `StreamableHTTPClientTransport`: that client
 * pulls in an ESM-only dependency jest's VM cannot load (the SERVER transport
 * loads fine). `mcp.spec.ts` covers the SDK client over the in-memory transport.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AgentsService } from '../agents.service';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore } from '../store/agent-store';
import { FakeAgentWalletProvider } from '../testing/fake-agent-wallet.provider';
import { AgentTools } from './context';
import { GATED_TOOLS } from './gate';
import { McpController } from './mcp.controller';
import { McpHttp } from './mcp-http';
import { MON_USDC, testMandateInput } from './testing/agent-fixture';
import { fakeVenues } from './testing/fake-venues';

const PROTOCOL = '2025-06-18';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'spec', version: '0' },
  },
};

const hireInput = {
  name: 'Momentum',
  systemPrompt: 'Trade carefully.',
  strategy: 'Buy strength.',
  model: 'anthropic/claude-sonnet-5',
  mandate: testMandateInput(),
};

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('/mcp over HTTP', () => {
  let app: INestApplication;
  let url: URL;
  let service: AgentsService;
  let mcp: McpHttp;
  let fakes: ReturnType<typeof fakeVenues>;

  beforeEach(async () => {
    const store = new InMemoryAgentStore();
    service = new AgentsService(store, new FakeAgentWalletProvider(), new ServerMandateOwners());
    fakes = fakeVenues();
    const tools = new AgentTools({
      store,
      events: new InMemoryAgentEventLog(),
      precheck: true,
      venuesFor: () => Promise.resolve(fakes.venues),
    });
    mcp = new McpHttp({
      authenticate: (token) => service.findByMcpToken(token),
      contextFor: (agent, runId) => tools.context(agent, { runId }),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpHttp, useValue: mcp }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = new URL('/mcp', await app.getUrl());
  });

  afterEach(async () => {
    await mcp.close();
    await app.close();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  /** One JSON-RPC exchange; the answer arrives as SSE `data:` lines. */
  async function rpc(token: string, body: unknown, sessionId?: string) {
    const response = await post(body, {
      ...bearer(token),
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL } : {}),
    });
    const text = await response.text();
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as RpcMessage);
    return {
      status: response.status,
      sessionId: response.headers.get('mcp-session-id') ?? sessionId,
      message: messages[0],
    };
  }

  async function openSession(token: string): Promise<string> {
    const opened = await rpc(token, INITIALIZE);
    expect(opened.status).toBe(200);
    expect(opened.message?.result?.['serverInfo']).toMatchObject({ name: 'sente' });
    const initialized = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { ...bearer(token), 'mcp-session-id': opened.sessionId!, 'mcp-protocol-version': PROTOCOL },
    );
    expect(initialized.status).toBe(202);
    return opened.sessionId!;
  }

  const callTool = (token: string, sessionId: string, id: number, name: string, args: unknown) =>
    rpc(
      token,
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      sessionId,
    );

  it('is 401 without a token, and with a wrong one', async () => {
    for (const headers of [
      {},
      bearer('sente_mcp_not-a-real-token'),
      { authorization: 'Basic x' },
    ]) {
      const response = await post(INITIALIZE, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /);
      expect(await response.json()).toMatchObject({ statusCode: 401, reason: 'unauthorized' });
    }
    expect(mcp.size).toBe(0);
  });

  it('serves the tools over a session, keeping the thesis across requests', async () => {
    const { mcpToken } = await service.hire({ userId: 'alice' }, hireInput);
    const session = await openSession(mcpToken);

    const listed = await rpc(mcpToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    const tools = listed.message?.result?.['tools'] as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(GATED_TOOLS.map((t) => t.name).sort());

    const order = { venue: 'kuru', market: MON_USDC, side: 'buy', size: '10', price: '3.5' };
    const early = await callTool(mcpToken, session, 3, 'place_limit', order);
    expect(early.message?.result).toMatchObject({ isError: true });

    await callTool(mcpToken, session, 4, 'record_thesis', {
      market: MON_USDC,
      direction: 'long',
      thesis: 'Up.',
      invalidation: 'Down.',
    });
    const placed = await callTool(mcpToken, session, 5, 'place_limit', order);
    expect(placed.message?.result?.['isError']).toBeFalsy();
    expect(fakes.kuru.writes()).toHaveLength(1);
    expect(mcp.size).toBe(1);
  });

  it("is 401 for a revoked agent's token, open sessions included", async () => {
    const { agent, mcpToken } = await service.hire({ userId: 'alice' }, hireInput);
    const session = await openSession(mcpToken);

    await service.revoke({ userId: 'alice' }, agent.id);

    expect((await post(INITIALIZE, bearer(mcpToken))).status).toBe(401);
    const inSession = await rpc(mcpToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    expect(inSession.status).toBe(401);
  });

  it("does not let one agent's token use another agent's session", async () => {
    const alice = await service.hire({ userId: 'alice' }, hireInput);
    const bob = await service.hire({ userId: 'bob' }, hireInput);
    const session = await openSession(alice.mcpToken);

    const hijack = await rpc(
      bob.mcpToken,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    );
    expect(hijack.status).toBe(404);
  });

  it('refuses a non-initialize request without a session', async () => {
    const { mcpToken } = await service.hire({ userId: 'alice' }, hireInput);
    const response = await rpc(mcpToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(response.status).toBe(400);
  });
});
