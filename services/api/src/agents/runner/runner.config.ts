/** DI token for the resolved agent runner configuration. */
export const AGENT_RUNNER_CONFIG = Symbol('AGENT_RUNNER_CONFIG');

export interface AgentRunnerConfig {
  /** Seconds between scheduled runs of every active agent; `undefined` = no scheduler (default). */
  readonly tickSeconds: number | undefined;
  /** Wall-clock budget for one run, enforced with an AbortController. */
  readonly timeoutMs: number;
  /** Model requests per run: the Tool Runner's `max_iterations`. */
  readonly maxIterations: number;
  /** `max_tokens` on every request. */
  readonly maxTokens: number;
  /**
   * Minimum gap between two signing writes of the same agent, counted from the
   * end of the previous one. See `write-spacing.ts` for why. 0 disables it.
   */
  readonly writeSpacingMs: number;
  /**
   * Send `thinking: {type: 'adaptive'}`. OFF until the credits probe shows it
   * passes through OpenRouter (docs/openrouter.md: pending credentials).
   */
  readonly thinking: boolean;
}

export const AGENT_RUNNER_DEFAULTS = {
  // Twelve model turns and a few spaced writes fit comfortably; a hung
  // upstream does not hold the agent's run slot for the SDK's 10 minutes.
  timeoutMs: 180_000,
  maxIterations: 12,
  maxTokens: 4096,
  // SEN-3: a second sign 5 s after the first was refused by the rolling cap;
  // one straight after was not. Not tied to GAS_DRIP_SENDER_SPACING_MS (2 s, Monad's reserve window, SEN-16); this one covers Privy's lag.
  writeSpacingMs: 5_000,
} as const;

/** Below this a scheduler would spend credits faster than any strategy needs. */
export const MIN_TICK_SECONDS = 30;

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}; got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Pure env -> config, so a typo fails the boot instead of silently running
 * agents on a timer (or not). Every variable is optional.
 *
 * - `AGENT_TICK_SECONDS`: unset, empty, `0` or `off` = no scheduler; else ≥ 30.
 * - `AGENT_RUN_TIMEOUT_MS`, `AGENT_RUN_MAX_ITERATIONS`, `AGENT_RUN_MAX_TOKENS`.
 * - `AGENT_WRITE_SPACING_MS`: 0 turns spacing off.
 * - `AGENT_RUNNER_THINKING`: `off` (default) or `adaptive`.
 */
export function loadAgentRunnerConfig(env: NodeJS.ProcessEnv = process.env): AgentRunnerConfig {
  const tickRaw = env['AGENT_TICK_SECONDS']?.trim().toLowerCase();
  const tickSeconds =
    !tickRaw || tickRaw === '0' || tickRaw === 'off'
      ? undefined
      : integer(env, 'AGENT_TICK_SECONDS', 0, { min: MIN_TICK_SECONDS, max: 86_400 });

  const thinkingRaw = env['AGENT_RUNNER_THINKING']?.trim().toLowerCase() || 'off';
  if (thinkingRaw !== 'off' && thinkingRaw !== 'adaptive') {
    throw new Error(`AGENT_RUNNER_THINKING must be "off" or "adaptive"; got "${thinkingRaw}"`);
  }

  return {
    tickSeconds,
    timeoutMs: integer(env, 'AGENT_RUN_TIMEOUT_MS', AGENT_RUNNER_DEFAULTS.timeoutMs, {
      min: 5_000,
      max: 600_000,
    }),
    maxIterations: integer(env, 'AGENT_RUN_MAX_ITERATIONS', AGENT_RUNNER_DEFAULTS.maxIterations, {
      min: 1,
      max: 50,
    }),
    maxTokens: integer(env, 'AGENT_RUN_MAX_TOKENS', AGENT_RUNNER_DEFAULTS.maxTokens, {
      min: 256,
      max: 64_000,
    }),
    writeSpacingMs: integer(env, 'AGENT_WRITE_SPACING_MS', AGENT_RUNNER_DEFAULTS.writeSpacingMs, {
      min: 0,
      max: 120_000,
    }),
    thinking: thinkingRaw === 'adaptive',
  };
}

/** Boot-time line. Loud when the scheduler is on, since it spends users' credits unprompted. */
export function describeAgentRunnerConfig(
  config: AgentRunnerConfig,
  logger: { log(message: string): void; warn(message: string): void },
): void {
  const base =
    `agent runner: timeout ${config.timeoutMs} ms, ${config.maxIterations} iterations, ` +
    `write spacing ${config.writeSpacingMs} ms, thinking ${config.thinking ? 'adaptive' : 'off'}`;
  if (config.tickSeconds === undefined) {
    logger.log(`${base}, scheduler off (AGENT_TICK_SECONDS unset)`);
    return;
  }
  logger.warn(`${base}, scheduler ON: every active agent runs every ${config.tickSeconds} s`);
}
