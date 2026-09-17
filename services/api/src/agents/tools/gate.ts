/**
 * `gate(tool)`: the only way a tool runs. Order of checks, per call:
 *
 * 1. The input must pass the tool's zod schema.
 * 2. Reads then run as they are.
 * 3. Writes take the agent's write lock (one write at a time per agent), then:
 *    a. the agent must still be active (re-read, so a revoke stops a live run);
 *    b. a write with a `thesisMarket` needs `record_thesis` for that market
 *       earlier in this run;
 *    c. `checkIntent` (layer 1) against the CURRENT mandate, unless
 *       `AGENT_PRECHECK=off`;
 *    d. the handler, which reaches the venue and, through it, the enclave.
 *
 * Nothing is thrown out of `invoke`: every outcome comes back as a
 * `ToolOutcome` whose message the model reads. Every refusal, and every
 * venue write whether it landed or failed, is appended to the event log.
 */
import { Logger } from '@nestjs/common';
import { checkIntent, type Intent } from '@sente/mandate';
import * as z from 'zod/v4';

import { type NewAgentEvent, type RefusalLayer } from '../events/agent-event-log';
import type { ToolContext } from './context';
import { isPositiveDecimal } from './decimal';
import {
  ENCLAVE_REFUSAL_MESSAGE,
  findEnclaveRefusal,
  modelSafeMessage,
  SenteRefusal,
} from './refusals';
import { AGENT_TOOLS, type AgentTool, type ToolKind } from './registry';

export type ToolOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      /** Model-facing. No stack, no secret. */
      readonly message: string;
      /** Set when a layer refused; absent for a venue failure. */
      readonly refusal?: { readonly layer: RefusalLayer; readonly code: string };
    };

export interface GatedTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly kind: ToolKind;
  invoke(ctx: ToolContext, args: unknown): Promise<ToolOutcome>;
}

const logger = new Logger('AgentTools');
const MAX_INPUT_ERROR = 500;

export function gate(tool: AgentTool): GatedTool {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    kind: tool.kind,
    async invoke(ctx, raw) {
      const parsed = tool.input.safeParse(raw ?? {});
      if (!parsed.success) {
        const detail = z.prettifyError(parsed.error).slice(0, MAX_INPUT_ERROR);
        return fail(tool, ctx, raw, new SenteRefusal('invalid_input', detail));
      }
      const args = parsed.data;
      if (tool.kind === 'read') {
        try {
          return { ok: true, result: await tool.handler(ctx, args) };
        } catch (error) {
          return fail(tool, ctx, args, error);
        }
      }
      return ctx.writeLock.run(ctx.agent.id, () => write(tool, ctx, args));
    },
  };
}

/** Every tool, gated. What the Tool Runner and the MCP server expose. */
export const GATED_TOOLS: readonly GatedTool[] = AGENT_TOOLS.map(gate);

async function write(tool: AgentTool, ctx: ToolContext, args: unknown): Promise<ToolOutcome> {
  let intent: Intent | undefined;
  try {
    const agent = await ctx.currentAgent();
    if (!agent || agent.status !== 'active') {
      throw new SenteRefusal('agent_inactive', 'this agent has been revoked and can no longer act');
    }
    const market = tool.thesisMarket?.(args);
    if (market !== undefined && !ctx.theses.has(market)) {
      throw new SenteRefusal(
        'thesis_required',
        `Record your thesis first: call record_thesis for ${market} before this write.`,
      );
    }
    if (tool.intent && ctx.precheck) {
      intent = await tool.intent(ctx, args);
      const refusal = checkIntent(agent.mandate, intent, ctx.now());
      if (refusal) throw new SenteRefusal(refusal.code, refusal.detail);
    }

    const result = await tool.handler(ctx, args);
    if (tool.intent) {
      await record(ctx, {
        kind: 'order',
        tool: tool.name,
        detail: { status: 'ok', precheck: ctx.precheck, args, intent, result },
      });
      const fill = fillOf(result, intent?.venue);
      if (fill) await record(ctx, { kind: 'fill', tool: tool.name, detail: fill });
      // A position close is its own event (SEN-20): the Ledger reads the
      // close and the venue's realised-PnL fields from `close`, not from an
      // order that happens to have been reduce-only.
      if (tool.name === 'close_position') {
        await record(ctx, {
          kind: 'close',
          tool: tool.name,
          detail: { ...(fill ?? {}), ...realisedOf(result) },
        });
      }
    }
    return { ok: true, result };
  } catch (error) {
    return fail(tool, ctx, args, error, intent);
  }
}

async function fail(
  tool: AgentTool,
  ctx: ToolContext,
  args: unknown,
  error: unknown,
  intent?: Intent,
): Promise<ToolOutcome> {
  if (error instanceof SenteRefusal) {
    await record(ctx, {
      kind: 'refusal',
      layer: 'sente',
      tool: tool.name,
      detail: { code: error.code, message: error.message, precheck: ctx.precheck, args, intent },
    });
    return { ok: false, message: error.message, refusal: { layer: 'sente', code: error.code } };
  }

  const enclave = findEnclaveRefusal(error);
  if (enclave) {
    await record(ctx, {
      kind: 'refusal',
      layer: 'enclave',
      tool: tool.name,
      detail: {
        code: enclave.reason,
        method: enclave.method,
        message: ENCLAVE_REFUSAL_MESSAGE,
        precheck: ctx.precheck,
        args,
        intent,
      },
    });
    return {
      ok: false,
      message: ENCLAVE_REFUSAL_MESSAGE,
      refusal: { layer: 'enclave', code: enclave.reason },
    };
  }

  const message = modelSafeMessage(error);
  if (tool.intent) {
    await record(ctx, {
      kind: 'order',
      tool: tool.name,
      detail: { status: 'failed', error: message, precheck: ctx.precheck, args, intent },
    });
  } else if (tool.kind === 'read') {
    logger.warn(`${tool.name} failed for agent ${ctx.agent.id}: ${message}`);
  }
  return { ok: false, message };
}

/**
 * Appends, and never lets the log decide the outcome: an order that landed
 * must not be reported to the model as failed (it would place it again).
 */
async function record(
  ctx: ToolContext,
  event: Omit<NewAgentEvent, 'agentId' | 'runId'>,
): Promise<void> {
  try {
    await ctx.events.append({ agentId: ctx.agent.id, runId: ctx.runId, ...event });
  } catch (error) {
    logger.error(
      `could not record a ${event.kind} event for agent ${ctx.agent.id}: ${String(error)}`,
    );
  }
}

/** A fill event for an order that filled at least partly. */
function fillOf(
  result: unknown,
  venue: string | undefined,
): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const order = result as Record<string, unknown>;
  if (typeof order['id'] !== 'string' || !isPositiveDecimal(order['filledSize'])) return undefined;
  return {
    orderId: order['id'],
    ...(venue !== undefined ? { venue } : {}),
    symbol: order['symbol'],
    side: order['side'],
    type: order['type'],
    status: order['status'],
    filledSize: order['filledSize'],
    averageFillPrice: order['averageFillPrice'],
    txHash: order['txHash'],
    // Richer per-fill record (SEN-20): the block the fills confirmed in, the
    // fee actually charged, and, for Perpl, the leverage the order carried.
    // Every one is present only when the venue reported it on the order.
    ...(order['blockNumber'] !== undefined ? { blockNumber: order['blockNumber'] } : {}),
    ...(order['fee'] !== undefined ? { fee: order['fee'] } : {}),
    ...(order['feeAsset'] !== undefined ? { feeAsset: order['feeAsset'] } : {}),
    ...(order['leverage'] !== undefined ? { leverage: order['leverage'] } : {}),
  };
}

/**
 * The venue's realised-PnL fields a closed position reports back, carried
 * onto the `close` event when present (Perpl's position `dpnl` and `fnd`,
 * mapped by the adapter to `realizedPnl` and `fundingPaid`).
 */
function realisedOf(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return {};
  const order = result as Record<string, unknown>;
  return {
    ...(order['realizedPnl'] !== undefined ? { realizedPnl: order['realizedPnl'] } : {}),
    ...(order['fundingPaid'] !== undefined ? { fundingPaid: order['fundingPaid'] } : {}),
  };
}

/** A tool result as the text both surfaces return. */
export function toResultText(result: unknown): string {
  return (
    JSON.stringify(result ?? null, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ) ?? 'null'
  );
}
