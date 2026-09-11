import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore } from '../store/agent-store';
import { AgentTools } from './context';
import { GATED_TOOLS } from './gate';
import { createMcpServer } from './mcp';
import { MON_USDC, testAgent } from './testing/agent-fixture';
import { fakeVenues } from './testing/fake-venues';

type TextResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connected() {
  const store = new InMemoryAgentStore();
  const agent = testAgent();
  await store.insert(agent);
  const events = new InMemoryAgentEventLog();
  const fakes = fakeVenues();
  const tools = new AgentTools({
    store,
    events,
    precheck: true,
    venuesFor: () => Promise.resolve(fakes.venues),
  });
  const server = createMcpServer(tools.context(agent, { runId: 'mcp-spec' }));
  const client = new Client({ name: 'spec', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { ...fakes, agent, events, server, client, call };
}

const order = {
  venue: 'kuru',
  market: MON_USDC,
  side: 'buy',
  size: '10',
  price: '3.5',
};

describe('Sente MCP server', () => {
  let h: Awaited<ReturnType<typeof connected>>;

  beforeEach(async () => {
    h = await connected();
  });

  afterEach(async () => {
    await h.client.close();
    await h.server.close();
  });

  it('lists every tool with its schema and read/write hint', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(GATED_TOOLS.map((t) => t.name).sort());

    const market = tools.find((t) => t.name === 'place_market')!;
    expect(market.inputSchema.required).toEqual(expect.arrayContaining(['slippageLimitPrice']));
    expect(market.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'get_mandate')!.annotations?.readOnlyHint).toBe(true);
  });

  it('returns a refusal as isError, and the order once the thesis is recorded', async () => {
    const noThesis = await h.call('place_limit', order);
    expect(noThesis.isError).toBe(true);
    expect(noThesis.content[0]!.text).toMatch(/^Refused by Sente mandate: thesis_required/);

    await h.call('record_thesis', {
      market: MON_USDC,
      direction: 'long',
      thesis: 'Breaking out.',
      invalidation: 'Back under 3.',
    });
    const overCap = await h.call('place_limit', { ...order, size: '100' });
    expect(overCap.isError).toBe(true);
    expect(overCap.content[0]!.text).toMatch(/^Refused by Sente mandate: notional_over_cap/);

    const placed = await h.call('place_limit', order);
    expect(placed.isError).toBeFalsy();
    expect(JSON.parse(placed.content[0]!.text)).toMatchObject({ symbol: MON_USDC, status: 'open' });
    expect(h.kuru.writes()).toHaveLength(1);

    const refusals = await h.events.list(h.agent.id, { kind: 'refusal' });
    expect(refusals.map((e) => [e.layer, e.runId])).toEqual([
      ['sente', 'mcp-spec'],
      ['sente', 'mcp-spec'],
    ]);
  });

  it('answers schema-invalid input with isError and never reaches the venue', async () => {
    const result = await h.call('place_market', {
      venue: 'kuru',
      market: MON_USDC,
      side: 'buy',
      size: '1',
    });
    expect(result.isError).toBe(true);
    expect(h.kuru.calls).toEqual([]);
  });
});
