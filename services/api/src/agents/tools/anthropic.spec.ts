import { ToolError } from '@anthropic-ai/sdk/resources/beta/messages';

import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore } from '../store/agent-store';
import { toRunnerTools } from './anthropic';
import { AgentTools } from './context';
import { GATED_TOOLS } from './gate';
import { MON_USDC, testAgent } from './testing/agent-fixture';
import { fakeVenues } from './testing/fake-venues';

async function setup() {
  const store = new InMemoryAgentStore();
  const agent = testAgent();
  await store.insert(agent);
  const fakes = fakeVenues();
  const tools = new AgentTools({
    store,
    events: new InMemoryAgentEventLog(),
    precheck: true,
    venuesFor: () => Promise.resolve(fakes.venues),
  });
  const runner = toRunnerTools(tools.context(agent));
  const byName = (name: string) => runner.find((t) => t.name === name)!;
  return { ...fakes, runner, byName };
}

describe('toRunnerTools', () => {
  it('exposes every gated tool with a JSON schema built from its zod schema', async () => {
    const { runner, byName } = await setup();
    expect(runner.map((t) => t.name)).toEqual(GATED_TOOLS.map((t) => t.name));

    // A custom tool (`type: 'custom'`), so the union narrows to one with a schema.
    const tool = byName('place_market') as unknown as {
      type: string;
      input_schema: Record<string, unknown>;
    };
    expect(tool.type).toBe('custom');
    const schema = tool.input_schema;
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(
      expect.arrayContaining(['venue', 'market', 'side', 'size', 'slippageLimitPrice']),
    );
  });

  it('validates input in parse, so the runner rejects it before run', async () => {
    const { byName } = await setup();
    expect(() => byName('place_limit').parse({ venue: 'kuru' })).toThrow();
    expect(byName('get_depth').parse({ venue: 'kuru', market: MON_USDC })).toEqual({
      venue: 'kuru',
      market: MON_USDC,
    });
  });

  it('returns JSON text on success and throws ToolError on a refusal', async () => {
    const { byName, kuru } = await setup();

    const balances = await byName('get_balances').run({ venue: 'kuru' });
    expect(JSON.parse(balances as string)).toEqual([
      expect.objectContaining({ venue: 'kuru', balances: expect.any(Array) }),
    ]);

    const error: unknown = await Promise.resolve(
      byName('place_limit').run({
        venue: 'kuru',
        market: MON_USDC,
        side: 'buy',
        size: '1',
        price: '3',
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).content).toMatch(/^Refused by Sente mandate: thesis_required/);
    expect(kuru.writes()).toEqual([]);
  });
});
