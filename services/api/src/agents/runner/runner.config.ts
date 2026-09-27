/** DI token for the resolved agent runner configuration. */
export const AGENT_RUNNER_CONFIG = Symbol('AGENT_RUNNER_CONFIG');

export interface AgentRunnerConfig {
  /**
   * Cadence, in seconds, for active agents WITHOUT a schedule of their own;
   * `undefined` = those run manually only (default). Since SEN-71 an agent's
   * own `schedule` wins, and this is the fallback.
   */
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
    logger.log(`${base}, default cadence off (AGENT_TICK_SECONDS unset)`);
    return;
  }
  logger.warn(
    `${base}, default cadence ON: every active agent without its own schedule runs every ` +
      `${config.tickSeconds} s`,
  );
}

/** DI token for the resolved scheduler configuration (SEN-71). */
export const AGENT_SCHEDULE_CONFIG = Symbol('AGENT_SCHEDULE_CONFIG');

/**
 * The scheduler's own knobs (SEN-71). Kept apart from `AgentRunnerConfig`,
 * which every run reads, because only the scheduler and its guard need these.
 */
export interface AgentScheduleConfig {
  /** How often the scheduler looks for due agents; `undefined` = no scheduled runs at all. */
  readonly pollSeconds: number | undefined;
  /** Scheduled runs open at once across the process; manual runs don't count. */
  readonly maxConcurrent: number;
  /** A scheduled run is skipped while the owner's key has less than this left, USD. */
  readonly minCreditsUsd: number;
  /** Scheduled runs one agent may start per UTC day. */
  readonly maxRunsPerDay: number;
}

export const AGENT_SCHEDULE_DEFAULTS = {
  pollSeconds: 15,
  // A few runs at once keeps Perpl's 10 req/min and OpenRouter's rate limits
  // out of reach when many cadences line up.
  maxConcurrent: 3,
  // Roughly one short run: below it a run would likely die mid-loop on a 402.
  minCreditsUsd: 0.1,
  // One every 5 min all day. At the 60 s minimum cadence an agent could
  // otherwise run 1,440 times a day (plan-backend.md, "Scheduler cost").
  maxRunsPerDay: 288,
} as const;

/**
 * Pure env -> scheduler config (SEN-71). Every variable is optional; a typo
 * fails the boot.
 *
 * - `AGENT_SCHEDULER_POLL_SECONDS`: default 15, 5..300; `0` or `off` turns
 *   every scheduled run off, per-agent cadences included.
 * - `AGENT_SCHEDULE_MAX_CONCURRENT`: default 3, 1..50.
 * - `AGENT_SCHEDULE_MIN_CREDITS_USD`: default 0.10, a decimal from 0 to 1000.
 * - `AGENT_SCHEDULE_MAX_RUNS_PER_DAY`: default 288, 1..1440.
 */
export function loadAgentScheduleConfig(env: NodeJS.ProcessEnv = process.env): AgentScheduleConfig {
  const pollRaw = env['AGENT_SCHEDULER_POLL_SECONDS']?.trim().toLowerCase();
  const pollSeconds =
    pollRaw === '0' || pollRaw === 'off'
      ? undefined
      : integer(env, 'AGENT_SCHEDULER_POLL_SECONDS', AGENT_SCHEDULE_DEFAULTS.pollSeconds, {
          min: 5,
          max: 300,
        });

  const creditsRaw = env['AGENT_SCHEDULE_MIN_CREDITS_USD']?.trim();
  let minCreditsUsd: number = AGENT_SCHEDULE_DEFAULTS.minCreditsUsd;
  if (creditsRaw) {
    if (!/^\d+(\.\d+)?$/.test(creditsRaw) || Number(creditsRaw) > 1000) {
      throw new Error(
        `AGENT_SCHEDULE_MIN_CREDITS_USD must be a decimal from 0 to 1000; got "${creditsRaw}"`,
      );
    }
    minCreditsUsd = Number(creditsRaw);
  }

  return {
    pollSeconds,
    maxConcurrent: integer(
      env,
      'AGENT_SCHEDULE_MAX_CONCURRENT',
      AGENT_SCHEDULE_DEFAULTS.maxConcurrent,
      { min: 1, max: 50 },
    ),
    minCreditsUsd,
    maxRunsPerDay: integer(
      env,
      'AGENT_SCHEDULE_MAX_RUNS_PER_DAY',
      AGENT_SCHEDULE_DEFAULTS.maxRunsPerDay,
      { min: 1, max: 1440 },
    ),
  };
}

/** Boot-time line for the scheduler (SEN-71). */
export function describeAgentScheduleConfig(
  runner: AgentRunnerConfig,
  schedule: AgentScheduleConfig,
  logger: { log(message: string): void; warn(message: string): void },
): void {
  if (schedule.pollSeconds === undefined) {
    logger.log('agent scheduler off (AGENT_SCHEDULER_POLL_SECONDS=off): no scheduled runs at all');
    return;
  }
  logger.log(
    `agent scheduler: poll every ${schedule.pollSeconds} s, ${schedule.maxConcurrent} at once, ` +
      `skip under $${schedule.minCreditsUsd} left, at most ${schedule.maxRunsPerDay} runs/agent/day; ` +
      (runner.tickSeconds === undefined
        ? 'agents without their own cadence run manually only'
        : `agents without their own cadence run every ${runner.tickSeconds} s`),
  );
}
