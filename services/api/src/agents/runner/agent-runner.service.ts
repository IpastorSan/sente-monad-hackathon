/**
 * The agent runner (SEN-8): one bounded Tool Runner loop over the gated tools,
 * with the agent's own model, prompt and strategy, billed to its owner's
 * OpenRouter key.
 *
 * Not the Claude Agent SDK: its built-in Bash and file tools are the wrong
 * shape for a trading agent. `client.beta.messages.toolRunner` loops only over
 * the tools we hand it, and every one of those goes through `gate()`.
 */
import { randomUUID } from 'node:crypto';

import type { BetaMessage, BetaToolRunnerParams } from '@anthropic-ai/sdk/resources/beta/messages';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { KURU_TESTNET_MARKETS } from '@sente/venues/kuru';
import { isAddressEqual } from 'viem';

import { CreditsRefusedError } from '../../credits/credits.errors';
import { CreditsService, type CreditsView } from '../../credits/credits.service';
import type { GasDripPrincipal } from '../../gas/auth/gas-drip-auth';
import { AGENT_MODEL_REQUEST_EXTRAS, type OpenRouterRequestExtras } from '../agents.config';
import { AgentRefusedError } from '../agents.errors';
import { AgentsService } from '../agents.service';
import { AGENT_EVENTS, type AgentEvent, type AgentEventLog } from '../events/agent-event-log';
import { AGENT_STORE, type AgentRecord, type AgentStore } from '../store/agent-store';
import { toRunnerTools } from '../tools/anthropic';
import { AgentTools, type ToolContext } from '../tools/context';
import { GATED_TOOLS } from '../tools/gate';
import {
  ANTHROPIC_CLIENT_FACTORY,
  classifyModelError,
  errorText,
  type AnthropicClientFactory,
} from './openrouter-client';
import { renderSystemPrompt, renderTickMessage } from './prompt';
import { AGENT_RUNNER_CONFIG, type AgentRunnerConfig } from './runner.config';
import { spaceWrites, WriteSpacer } from './write-spacing';

/**
 * How a run ended.
 *
 * - The model's own: `end_turn`, `stop_sequence`, and the three the Tool
 *   Runner ends on QUIETLY — `refusal`, `max_tokens`,
 *   `model_context_window_exceeded` — which is why the runner reads the last
 *   message's `stop_reason` itself.
 * - `max_iterations`: the loop hit its cap while the model still wanted tools.
 * - `timeout`: the wall-clock budget ran out (AbortController).
 * - `agent_revoked`: the agent was revoked while the run was open.
 * - `credits_exhausted`: OpenRouter's 402, or a key with nothing left.
 * - `model_error`: any other API failure. `error` says which, redacted.
 */
export const RUN_STOP_REASONS = [
  'end_turn',
  'stop_sequence',
  'refusal',
  'max_tokens',
  'model_context_window_exceeded',
  'max_iterations',
  'timeout',
  'agent_revoked',
  'credits_exhausted',
  'model_error',
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export type RunTrigger = 'manual' | 'schedule';

export interface RunOptions {
  /** Untrusted, per-run guidance from the user, fenced in the first message. */
  readonly instruction?: string | undefined;
  readonly trigger?: RunTrigger;
}

export interface RunResult {
  readonly runId: string;
  readonly agentId: string;
  readonly trigger: RunTrigger;
  readonly model: string;
  readonly stopReason: RunStopReason;
  /** Model requests made (the Tool Runner's iterations). */
  readonly iterations: number;
  /** `tool_use` blocks the model emitted across the run. */
  readonly toolCalls: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** The model's last text, truncated. What it said when it stopped. */
  readonly finalText?: string;
  /** Why a failed run failed. Redacted: never carries the key. */
  readonly error?: string;
  /**
   * USD: the sum of OpenRouter's per-response `usage.cost` when it reports
   * one, else the key's `usage_monthly` delta when that has already moved.
   * Absent when neither is known (OpenRouter records usage asynchronously).
   */
  readonly costUsd?: number;
  /** Every event this run produced — theses, orders, fills, refusals — and its `run` summary last. */
  readonly events: AgentEvent[];
}

/** The slice of CreditsService the runner uses. `keyFor` is server-only. */
export type RunnerCredits = Pick<CreditsService, 'keyFor' | 'provision' | 'status'>;

const MAX_LOGGED_INPUT = 300;
const MAX_FINAL_TEXT = 2_000;
const SNAPSHOT_DEPTH_LEVELS = 5;

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);
  /** Agents with a run open in this process. One run per agent at a time. */
  private readonly running = new Set<string>();

  constructor(
    private readonly agents: AgentsService,
    @Inject(AGENT_STORE) private readonly store: Pick<AgentStore, 'get'>,
    private readonly tools: AgentTools,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
    @Inject(CreditsService) private readonly credits: RunnerCredits,
    @Inject(AGENT_RUNNER_CONFIG) private readonly config: AgentRunnerConfig,
    @Inject(ANTHROPIC_CLIENT_FACTORY) private readonly clientFor: AnthropicClientFactory,
    private readonly spacer: WriteSpacer,
  ) {}

  /** Whether `agentId` has a run open right now. */
  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /**
   * Runs the agent once. Refuses (throws) before anything is spent:
   * `agent_not_found` (also another user's agent), `agent_revoked`,
   * `run_in_progress`, and the credits refusals (`credits_unconfigured`,
   * `provision_failed`). Once the run starts it RETURNS, whatever happened;
   * the stop reason says how it went.
   */
  async run(
    principal: GasDripPrincipal,
    agentId: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const agent = await this.agents.get(principal, agentId);
    if (agent.status !== 'active') {
      throw new AgentRefusedError('agent_revoked', `agent ${agentId} is revoked and cannot run`);
    }
    // Checked and claimed with no await in between, so two callers cannot both pass.
    if (this.running.has(agentId)) {
      throw new AgentRefusedError(
        'run_in_progress',
        `agent ${agentId} is already running; one run per agent at a time`,
      );
    }
    this.running.add(agentId);
    try {
      return await this.execute(principal, agent, options);
    } finally {
      this.running.delete(agentId);
    }
  }

  private async execute(
    principal: GasDripPrincipal,
    agent: AgentRecord,
    options: RunOptions,
  ): Promise<RunResult> {
    const runId = `run-${randomUUID()}`;
    const trigger = options.trigger ?? 'manual';
    const startedAt = Date.now();
    // Throws the credits refusals; nothing has been spent yet.
    const key = await this.userKey(principal);
    const before = await this.creditsView(principal);

    let stopReason: RunStopReason;
    let iterations = 0;
    let toolCalls = 0;
    let reportedCostUsd = 0;
    let last: BetaMessage | undefined;
    let error: string | undefined;

    this.logger.log(
      `run ${runId} agent ${agent.id} (${trigger}, ${agent.model}, precheck ` +
        `${this.tools.precheck ? 'on' : 'off'}) started`,
    );

    if (before && before.remainingUsd !== null && before.remainingUsd <= 0) {
      stopReason = 'credits_exhausted';
      error = 'the OpenRouter key has no budget left this month';
    } else {
      const abort = new AbortController();
      let timedOut = false;
      let revoked = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, this.config.timeoutMs);

      try {
        const ctx = this.tools.context(agent, { runId });
        const snapshot = await this.snapshot(ctx);
        const client = this.clientFor(key, { timeoutMs: this.config.timeoutMs });
        // The intersection carries OpenRouter's `provider` through the SDK,
        // which serialises the whole params object (docs/openrouter.md).
        // `stream?: false` selects the overload that yields whole messages.
        const params: BetaToolRunnerParams & OpenRouterRequestExtras & { stream?: false } = {
          model: agent.model,
          max_tokens: this.config.maxTokens,
          system: renderSystemPrompt(agent, Math.floor(Date.now() / 1000)),
          tools: toRunnerTools(ctx, spaceWrites(GATED_TOOLS, this.spacer, abort.signal)),
          messages: [
            {
              role: 'user',
              content: renderTickMessage({
                nowMs: Date.now(),
                snapshot,
                instruction: options.instruction,
              }),
            },
          ],
          max_iterations: this.config.maxIterations,
          ...(this.config.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
          ...AGENT_MODEL_REQUEST_EXTRAS[agent.model],
        };
        const runner = client.beta.messages.toolRunner(params, { signal: abort.signal });

        for await (const message of runner) {
          iterations += 1;
          last = message;
          reportedCostUsd += reportedCost(message);
          for (const block of message.content) {
            if (block.type !== 'tool_use') continue;
            toolCalls += 1;
            this.logger.log(
              `run ${runId} agent ${agent.id} turn ${iterations}: ${block.name} ` +
                truncate(JSON.stringify(block.input), MAX_LOGGED_INPUT),
            );
          }
          // Before this turn's tools run: a revoked agent stops here, rather
          // than spending more of its owner's credits on refused writes.
          if ((await this.store.get(agent.id))?.status !== 'active') {
            revoked = true;
            abort.abort();
            break;
          }
        }

        stopReason = revoked ? 'agent_revoked' : stopReasonOf(last);
      } catch (caught) {
        const failure = classifyModelError(caught);
        if (revoked) stopReason = 'agent_revoked';
        else if (timedOut) stopReason = 'timeout';
        else if (failure === 'credits_exhausted') stopReason = 'credits_exhausted';
        else stopReason = 'model_error';
        if (stopReason === 'model_error' && (await this.exhausted(principal))) {
          stopReason = 'credits_exhausted';
        }
        error = errorText(caught, key);
      } finally {
        clearTimeout(timer);
      }
    }

    const endedAt = Date.now();
    const after =
      stopReason === 'credits_exhausted' && iterations === 0
        ? before
        : await this.creditsView(principal);
    const keyUsageDeltaUsd =
      before && after ? round(after.usageMonthUsd - before.usageMonthUsd) : undefined;
    const costUsd =
      reportedCostUsd > 0
        ? round(reportedCostUsd)
        : keyUsageDeltaUsd !== undefined && keyUsageDeltaUsd > 0
          ? keyUsageDeltaUsd
          : undefined;
    const finalText = last ? truncate(textOf(last), MAX_FINAL_TEXT) : undefined;

    const summary = {
      trigger,
      model: agent.model,
      stopReason,
      iterations,
      toolCalls,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      precheck: this.tools.precheck,
      ...(options.instruction ? { instruction: options.instruction } : {}),
      ...(finalText ? { finalText } : {}),
      ...(error ? { error } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(reportedCostUsd > 0 ? { reportedCostUsd: round(reportedCostUsd) } : {}),
      ...(keyUsageDeltaUsd !== undefined ? { keyUsageDeltaUsd } : {}),
    };
    try {
      await this.events.append({ agentId: agent.id, runId, kind: 'run', detail: summary });
    } catch (appendError) {
      this.logger.error(`run ${runId}: could not record its summary: ${String(appendError)}`);
    }

    const line =
      `run ${runId} agent ${agent.id} ended: ${stopReason} after ${iterations} ` +
      `iteration(s), ${toolCalls} tool call(s)` +
      (costUsd !== undefined ? `, $${costUsd}` : '') +
      (error ? ` — ${error}` : '');
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') this.logger.log(line);
    else this.logger.warn(line);

    return {
      runId,
      agentId: agent.id,
      trigger,
      model: agent.model,
      stopReason,
      iterations,
      toolCalls,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      durationMs: summary.durationMs,
      ...(finalText ? { finalText } : {}),
      ...(error ? { error } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      events: await this.events.list(agent.id, { runId }),
    };
  }

  /** The owner's key, provisioning it on first use. Never logged, never returned. */
  private async userKey(principal: GasDripPrincipal): Promise<string> {
    try {
      return await this.credits.keyFor(principal.userId);
    } catch (error) {
      if (!(error instanceof CreditsRefusedError) || error.reason !== 'not_provisioned')
        throw error;
    }
    await this.credits.provision(principal);
    return this.credits.keyFor(principal.userId);
  }

  /** The key's limit and usage, or undefined when OpenRouter cannot say. Never fails a run. */
  private async creditsView(principal: GasDripPrincipal): Promise<CreditsView | undefined> {
    try {
      return await this.credits.status(principal);
    } catch (error) {
      this.logger.warn(`could not read credits for ${principal.userId}: ${errorText(error)}`);
      return undefined;
    }
  }

  private async exhausted(principal: GasDripPrincipal): Promise<boolean> {
    const view = await this.creditsView(principal);
    return view !== undefined && view.remainingUsd !== null && view.remainingUsd <= 0;
  }

  /**
   * The first message's snapshot: balances, positions, open orders and the
   * depth of every market the mandate allows. Read through the SAME gated read
   * tools the model has, so it sees nothing the tools would not show it. A
   * read that fails becomes `{error}` in the snapshot; it never fails the run.
   */
  private async snapshot(ctx: ToolContext): Promise<Record<string, unknown>> {
    const { mandate } = ctx.agent;
    const read = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const tool = GATED_TOOLS.find((t) => t.name === name);
      if (!tool) return { error: `no tool ${name}` };
      const outcome = await tool.invoke(ctx, args);
      return outcome.ok ? outcome.result : { error: outcome.message };
    };

    const kuru = mandate.venues.includes('kuru');
    // Only read Perpl when this process has the agent's Perpl key (SEN-19): the
    // mandate may allow Perpl before the wallet has enrolled one.
    const perplAllowed = mandate.venues.includes('perpl');
    const perpl =
      perplAllowed &&
      Boolean(
        await ctx.venues().then(
          (v) => v.perpl,
          () => undefined,
        ),
      );
    const kuruMarkets = kuru
      ? mandate.kuru.markets.flatMap((address) => {
          const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address));
          return market ? [market.symbol] : [];
        })
      : [];
    const perplMarkets = perpl ? mandate.perpl.markets : [];
    const markets = [
      ...kuruMarkets.map((market) => ({ venue: 'kuru', market })),
      ...perplMarkets.map((market) => ({ venue: 'perpl', market })),
    ];

    const [balances, positions, kuruOrders, perplOrders, ...depths] = await Promise.all([
      read('get_balances', {}),
      perpl ? read('get_positions', {}) : Promise.resolve(undefined),
      kuru ? read('get_open_orders', { venue: 'kuru' }) : Promise.resolve(undefined),
      perpl ? read('get_open_orders', { venue: 'perpl' }) : Promise.resolve(undefined),
      ...markets.map((m) => read('get_depth', { ...m, limit: SNAPSHOT_DEPTH_LEVELS })),
    ]);

    // Nansen smart-money context (SEN-29), only with a key set: without one the
    // tool just answers `not_configured`, and the free plan's credits are too
    // scarce to spend per snapshot on every market. One market, the first
    // allowed — the tool's own 10-minute cache keeps repeat runs cheap.
    const nansenMarket = markets[0]?.market;
    const smartMoney =
      nansenMarket && (process.env['NANSEN_API_KEY'] ?? '').trim()
        ? await read('smart_money_signals', { market: nansenMarket })
        : undefined;

    return {
      balances,
      ...(perplAllowed && !perpl
        ? { perpl: 'not set up for this agent yet (no enrolled API key)' }
        : {}),
      ...(perpl ? { positions } : {}),
      openOrders: {
        ...(kuru ? { kuru: kuruOrders } : {}),
        ...(perpl ? { perpl: perplOrders } : {}),
      },
      depth: Object.fromEntries(markets.map((m, i) => [`${m.venue}:${m.market}`, depths[i]])),
      ...(smartMoney !== undefined ? { smartMoney } : {}),
    };
  }
}

/** The run's stop reason from the last message. See `RunStopReason`. */
export function stopReasonOf(message: BetaMessage | undefined): RunStopReason {
  switch (message?.stop_reason) {
    // The loop only ends on these when `max_iterations` cut it off.
    case 'tool_use':
    case 'pause_turn':
    case 'compaction':
      return 'max_iterations';
    case 'stop_sequence':
    case 'refusal':
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return message.stop_reason;
    default:
      // `end_turn`, and a provider that sends no stop reason on a normal finish.
      return 'end_turn';
  }
}

/** OpenRouter adds `usage.cost` (USD) to each response; the SDK does not type it. */
function reportedCost(message: BetaMessage): number {
  const cost = (message.usage as unknown as { cost?: unknown } | undefined)?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function textOf(message: BetaMessage): string {
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
