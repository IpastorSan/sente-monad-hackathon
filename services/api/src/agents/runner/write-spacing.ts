/**
 * WRITE SPACING — the one place the runner slows an agent's writes down.
 *
 * Why: Privy's rolling-cap aggregation is enforced LATE (SEN-3, live probe
 * checks 5 and 5d). A second approve signed straight after the first still
 * signed and overshot the cap; the same attempt 5 s later was refused. And a
 * sign right after a policy PATCH can still run under the old rule (run 5). So
 * the enclave's rolling cap is not an exact bound for back-to-back signs, and
 * a model that fires several writes in one turn (the Tool Runner runs a turn's
 * tool calls with `Promise.all`) would hit exactly that gap.
 *
 * What: per agent, process-wide, one signing write at a time, and the next one
 * starts no sooner than `spacingMs` after the previous one FINISHED. Counted
 * from the end, like `GAS_DRIP_SENDER_SPACING_MS`, because the enclave records
 * a signature when it is made, not when it was requested.
 *
 * What it is not: a guarantee. It narrows the window Privy leaves open; the
 * rolling cap stays a best-effort bound. The per-order cap (`maxOrderNotional`,
 * layer 1) and the enclave's per-transaction rules are exact.
 *
 * `record_thesis` signs nothing and is never spaced. The MCP surface is not
 * spaced either: it has its own client, and SEN-8 only owns the runner.
 */
import type { ToolContext } from '../tools/context';
import type { GatedTool, ToolOutcome } from '../tools/gate';

/** Writes that never reach the enclave. */
const UNSIGNED_WRITES = new Set(['record_thesis']);

export interface WriteSpacerOptions {
  readonly spacingMs: number;
  readonly now?: () => number;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class WriteSpacer {
  readonly spacingMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Per agent: when its last signing write finished (epoch ms). */
  readonly #lastEnd = new Map<string, number>();
  /** Per agent: the tail of its queue of signing writes. */
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: WriteSpacerOptions) {
    this.spacingMs = options.spacingMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  /**
   * Runs `task` once every earlier write of `agentId` has finished and
   * `spacingMs` has passed since the last one ended. Rejects, without running
   * `task`, if `signal` aborts while it waits.
   */
  async run<T>(agentId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#tails.get(agentId) ?? Promise.resolve();
    const result = previous.then(async () => {
      const last = this.#lastEnd.get(agentId);
      const wait = last === undefined ? 0 : last + this.spacingMs - this.#now();
      if (wait > 0) await this.#sleep(wait, signal);
      if (signal?.aborted) throw new Error('aborted');
      try {
        return await task();
      } finally {
        this.#lastEnd.set(agentId, this.#now());
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(agentId, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(agentId) === tail) this.#tails.delete(agentId);
    }
  }
}

export const SPACING_ABORTED_MESSAGE =
  'Not sent: the run ended (timeout) while this write waited for its turn. Nothing was signed.';

/**
 * The gated tools with every signing write routed through `spacer`. Reads and
 * `record_thesis` pass straight through. A spacing of 0 returns the tools as
 * they are.
 */
export function spaceWrites(
  tools: readonly GatedTool[],
  spacer: WriteSpacer,
  signal?: AbortSignal,
): GatedTool[] {
  if (spacer.spacingMs <= 0) return [...tools];
  return tools.map((tool) =>
    tool.kind !== 'write' || UNSIGNED_WRITES.has(tool.name)
      ? tool
      : {
          ...tool,
          invoke: (ctx: ToolContext, args: unknown): Promise<ToolOutcome> =>
            spacer
              .run(ctx.agent.id, () => tool.invoke(ctx, args), signal)
              .catch((error: unknown): ToolOutcome => {
                if (signal?.aborted) return { ok: false, message: SPACING_ABORTED_MESSAGE };
                throw error;
              }),
        },
  );
}
