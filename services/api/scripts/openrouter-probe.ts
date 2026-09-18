// Live probe (MOV-279): do tool calls round-trip through OpenRouter's
// Anthropic-compatible /v1/messages endpoint, for Claude and for Kimi?
//
//   pnpm --filter @sente/api run probe:openrouter
//
// That script loads the repo-root .env. Needs OPENROUTER_MANAGEMENT_KEY; without
// it the probe prints "pending credentials" and exits 0, spending nothing.
//
// What it does:
//   1. Confirms both model ids on GET /api/v1/models (public).
//   2. Mints a THROWAWAY key with a $1 limit that self-expires in an hour, via
//      the same OpenRouterManagementClient the API ships.
//   3. Per model: one tool (`get_price`) over two turns — tool_use ->
//      tool_result -> final answer — then one call with
//      `thinking: {type: 'adaptive'}`. Reads the key's usage back after each.
//   4. Deletes the key, whatever happened.
//
// Secrets: neither the management key nor the minted key is ever printed. Only
// the key's hash-free usage numbers and model output are.
//
// Cost: a few thousand tokens per model — well under the $1 cap.

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

import { OpenRouterManagementClient } from '../src/credits/openrouter.client.ts';

const OPENROUTER_ANTHROPIC_BASE = 'https://openrouter.ai/api';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Override with PROBE_ANTHROPIC_MODEL when the runner's default changes. */
const ANTHROPIC_MODEL = process.env['PROBE_ANTHROPIC_MODEL']?.trim() || 'anthropic/claude-sonnet-5';
const KIMI_MODEL = 'moonshotai/kimi-k2.6';

interface Target {
  label: string;
  model: string;
  /** OpenRouter routing preferences; not part of the Anthropic schema, passed through. */
  provider?: { order: string[]; allow_fallbacks: boolean };
}

const TARGETS: Target[] = [
  { label: 'anthropic', model: ANTHROPIC_MODEL },
  {
    label: 'kimi',
    model: KIMI_MODEL,
    provider: { order: ['Moonshot AI'], allow_fallbacks: false },
  },
];

const GET_PRICE: Tool = {
  name: 'get_price',
  description: 'Returns the current USD price of a crypto asset by ticker symbol.',
  input_schema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Ticker, e.g. MON' } },
    required: ['symbol'],
  },
};
const FAKE_PRICE = { symbol: 'MON', usd: 0.4213 };
const QUESTION =
  'What is the price of MON right now? Use the get_price tool, then answer in one sentence.';

type Params = MessageCreateParamsNonStreaming & { provider?: Target['provider'] };

interface RoundTrip {
  toolCalled: boolean;
  toolInput?: unknown;
  firstStopReason?: string | null;
  finalStopReason?: string | null;
  finalText?: string;
  /** The final answer mentions the price we returned: the tool_result was actually read. */
  usedToolResult?: boolean;
  servedBy?: string;
  error?: string;
}

interface ThinkingCheck {
  accepted: boolean;
  thinkingBlocks?: number;
  servedBy?: string;
  error?: string;
}

interface TargetResult {
  label: string;
  model: string;
  listed: boolean;
  listedWithTools: boolean;
  roundTrip: RoundTrip;
  thinking: ThinkingCheck;
  /** Reported per response in `usage.cost` (an OpenRouter extension), summed. */
  reportedCostUsd: number;
  /** Delta of the key's `usage` from GET /keys/:hash across this target's calls. */
  keyUsageDeltaUsd: number | null;
}

async function main(): Promise<number> {
  const managementKey = process.env['OPENROUTER_MANAGEMENT_KEY']?.trim();
  const sharedKey = process.env['OPENROUTER_API_KEY']?.trim();
  if (!managementKey && !sharedKey) {
    console.log(
      'pending credentials: neither OPENROUTER_MANAGEMENT_KEY nor OPENROUTER_API_KEY is set',
    );
    console.log(
      'Set it in the repo-root .env, then: pnpm --filter @sente/api run probe:openrouter',
    );
    return 0;
  }

  const listing = await listModels();
  if (!managementKey) {
    return probeSharedKey(listing, sharedKey as string);
  }
  const management = new OpenRouterManagementClient({ managementKey });
  const created = await management.createKey({
    name: `sente:probe:${new Date().toISOString()}`,
    limit: 1,
    limit_reset: null,
    include_byok_in_limit: true,
    // Dead-man switch: a crashed probe cannot leave a live key behind for long.
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  console.log(`minted throwaway key (limit $${created.data.limit}), expires in 1h`);

  // Bearer auth with no x-api-key. `apiKey: null` is load-bearing: left
  // undefined, the SDK falls back to process.env.ANTHROPIC_API_KEY and would
  // send a real Anthropic key to OpenRouter in an X-Api-Key header.
  const client = new Anthropic({
    baseURL: OPENROUTER_ANTHROPIC_BASE,
    authToken: created.key,
    apiKey: null,
  });

  const results: TargetResult[] = [];
  try {
    for (const target of TARGETS) {
      const before = await usage(management, created.data.hash);
      const cost = { usd: 0 };
      const roundTrip = await probeToolRoundTrip(client, target, cost);
      const thinking = await probeThinking(client, target, cost);
      const after = await settledUsage(management, created.data.hash, before);
      const entry = listing.get(target.model);
      results.push({
        label: target.label,
        model: target.model,
        listed: entry !== undefined,
        listedWithTools: entry?.includes('tools') ?? false,
        roundTrip,
        thinking,
        reportedCostUsd: round(cost.usd),
        keyUsageDeltaUsd: before === null || after === null ? null : round(after - before),
      });
    }
  } finally {
    await management.deleteKey(created.data.hash).then(
      () => console.log('deleted throwaway key'),
      (error: unknown) => console.error(`FAILED to delete throwaway key: ${text(error)}`),
    );
  }

  console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  return 0;
}

/**
 * Shared-key dev mode (SEN-18): the same round trips on the one inference key.
 * Nothing is minted or deleted, and the key's usage delta is not measured.
 */
async function probeSharedKey(
  listing: Awaited<ReturnType<typeof listModels>>,
  sharedKey: string,
): Promise<number> {
  console.log('shared-key mode (OPENROUTER_API_KEY): no key minted; usage deltas not measured');
  const client = new Anthropic({
    baseURL: OPENROUTER_ANTHROPIC_BASE,
    authToken: sharedKey,
    apiKey: null,
  });
  const results: TargetResult[] = [];
  for (const target of TARGETS) {
    const cost = { usd: 0 };
    const roundTrip = await probeToolRoundTrip(client, target, cost);
    const thinking = await probeThinking(client, target, cost);
    const entry = listing.get(target.model);
    results.push({
      label: target.label,
      model: target.model,
      listed: entry !== undefined,
      listedWithTools: entry?.includes('tools') ?? false,
      roundTrip,
      thinking,
      reportedCostUsd: round(cost.usd),
      keyUsageDeltaUsd: null,
    });
  }
  console.log(
    JSON.stringify({ probedAt: new Date().toISOString(), mode: 'shared', results }, null, 2),
  );
  return 0;
}

async function probeToolRoundTrip(
  client: Anthropic,
  target: Target,
  cost: { usd: number },
): Promise<RoundTrip> {
  const messages: MessageParam[] = [{ role: 'user', content: QUESTION }];
  try {
    const first = await create(client, target, { messages, tools: [GET_PRICE] }, cost);
    const call = first.content.find((block) => block.type === 'tool_use');
    if (!call || call.type !== 'tool_use') {
      return {
        toolCalled: false,
        firstStopReason: first.stop_reason,
        finalText: textOf(first.content),
        servedBy: servedBy(first),
      };
    }

    messages.push({ role: 'assistant', content: first.content });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(FAKE_PRICE) }],
    });
    const second = await create(client, target, { messages, tools: [GET_PRICE] }, cost);
    const finalText = textOf(second.content);
    return {
      toolCalled: true,
      toolInput: call.input,
      firstStopReason: first.stop_reason,
      finalStopReason: second.stop_reason,
      finalText,
      usedToolResult: finalText.includes('0.42'),
      servedBy: servedBy(second),
    };
  } catch (error) {
    return { toolCalled: false, error: text(error) };
  }
}

async function probeThinking(
  client: Anthropic,
  target: Target,
  cost: { usd: number },
): Promise<ThinkingCheck> {
  try {
    const response = await create(
      client,
      target,
      {
        messages: [{ role: 'user', content: 'Is 391 prime? Answer yes or no.' }],
        thinking: { type: 'adaptive' },
      },
      cost,
    );
    return {
      accepted: true,
      thinkingBlocks: response.content.filter((block) => block.type === 'thinking').length,
      servedBy: servedBy(response),
    };
  } catch (error) {
    return { accepted: false, error: text(error) };
  }
}

async function create(
  client: Anthropic,
  target: Target,
  params: Omit<MessageCreateParamsNonStreaming, 'model' | 'max_tokens'>,
  cost: { usd: number },
) {
  const body: Params = {
    model: target.model,
    max_tokens: 2048,
    ...params,
    ...(target.provider ? { provider: target.provider } : {}),
  };
  const response = await client.messages.create(body);
  const reported = (response.usage as { cost?: unknown }).cost;
  if (typeof reported === 'number') {
    cost.usd += reported;
  }
  return response;
}

/** model id -> supported_parameters, from the public model list. */
async function listModels(): Promise<Map<string, string[]>> {
  const response = await fetch(MODELS_URL);
  if (!response.ok) {
    throw new Error(`GET /models: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    data: { id: string; supported_parameters?: string[] }[];
  };
  const models = new Map(body.data.map((m) => [m.id, m.supported_parameters ?? []]));
  const claude = [...models.keys()].filter((id) => /^anthropic\/claude-[^:]+$/.test(id));
  console.log(`models: ${models.size} listed; anthropic: ${claude.join(', ')}`);
  for (const { model } of TARGETS) {
    const params = models.get(model);
    console.log(
      `  ${model}: ${params ? `listed, tools=${params.includes('tools')}` : 'NOT LISTED'}`,
    );
  }
  return models;
}

async function usage(api: OpenRouterManagementClient, hash: string): Promise<number | null> {
  try {
    return (await api.getKey(hash)).usage;
  } catch (error) {
    console.error(`could not read key usage: ${text(error)}`);
    return null;
  }
}

/** Usage is recorded asynchronously upstream; give it a few seconds to move. */
async function settledUsage(
  api: OpenRouterManagementClient,
  hash: string,
  before: number | null,
): Promise<number | null> {
  let latest = await usage(api, hash);
  for (let attempt = 0; attempt < 5 && latest !== null && latest === before; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    latest = await usage(api, hash);
  }
  return latest;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim();
}

/** OpenRouter adds the upstream provider to the response body. */
function servedBy(response: object): string | undefined {
  const provider = (response as { provider?: unknown }).provider;
  return typeof provider === 'string' ? provider : undefined;
}

function text(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return `HTTP ${error.status ?? '?'} ${error.message}`.replace(/\s+/g, ' ').slice(0, 400);
  }
  return error instanceof Error ? error.message : String(error);
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`probe failed: ${text(error)}`);
    process.exit(1);
  },
);
