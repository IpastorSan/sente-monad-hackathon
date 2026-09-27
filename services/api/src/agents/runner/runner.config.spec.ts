import {
  AGENT_RUNNER_DEFAULTS,
  describeAgentRunnerConfig,
  describeAgentScheduleConfig,
  loadAgentRunnerConfig,
  loadAgentScheduleConfig,
} from './runner.config';

describe('loadAgentRunnerConfig', () => {
  it('defaults: no scheduler, thinking off, 5 s write spacing', () => {
    expect(loadAgentRunnerConfig({})).toEqual({
      tickSeconds: undefined,
      timeoutMs: AGENT_RUNNER_DEFAULTS.timeoutMs,
      maxIterations: 12,
      maxTokens: 4096,
      writeSpacingMs: 5_000,
      thinking: false,
    });
  });

  it.each(['', '0', 'off', 'OFF', '  '])('AGENT_TICK_SECONDS=%j is off', (value) => {
    expect(loadAgentRunnerConfig({ AGENT_TICK_SECONDS: value }).tickSeconds).toBeUndefined();
  });

  it('turns the scheduler on at 30 s or more, and refuses anything else', () => {
    expect(loadAgentRunnerConfig({ AGENT_TICK_SECONDS: '300' }).tickSeconds).toBe(300);
    for (const bad of ['10', '29', '1.5', '-60', 'hourly']) {
      expect(() => loadAgentRunnerConfig({ AGENT_TICK_SECONDS: bad })).toThrow(
        /AGENT_TICK_SECONDS/,
      );
    }
  });

  it('reads the loop bounds and the write spacing, 0 included', () => {
    const config = loadAgentRunnerConfig({
      AGENT_RUN_TIMEOUT_MS: '60000',
      AGENT_RUN_MAX_ITERATIONS: '4',
      AGENT_RUN_MAX_TOKENS: '2048',
      AGENT_WRITE_SPACING_MS: '0',
    });
    expect(config).toMatchObject({
      timeoutMs: 60_000,
      maxIterations: 4,
      maxTokens: 2048,
      writeSpacingMs: 0,
    });
    expect(() => loadAgentRunnerConfig({ AGENT_RUN_MAX_ITERATIONS: '0' })).toThrow();
    expect(() => loadAgentRunnerConfig({ AGENT_RUN_TIMEOUT_MS: '100' })).toThrow();
  });

  it('thinking is off unless AGENT_RUNNER_THINKING=adaptive; a typo fails', () => {
    expect(loadAgentRunnerConfig({ AGENT_RUNNER_THINKING: 'adaptive' }).thinking).toBe(true);
    expect(loadAgentRunnerConfig({ AGENT_RUNNER_THINKING: 'off' }).thinking).toBe(false);
    expect(() => loadAgentRunnerConfig({ AGENT_RUNNER_THINKING: 'on' })).toThrow(
      /AGENT_RUNNER_THINKING/,
    );
  });

  it('describes the default cadence loudly when it is on', () => {
    const lines: string[] = [];
    const logger = {
      log: (m: string) => lines.push(`log ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
    };
    describeAgentRunnerConfig(loadAgentRunnerConfig({}), logger);
    describeAgentRunnerConfig(loadAgentRunnerConfig({ AGENT_TICK_SECONDS: '60' }), logger);
    expect(lines[0]).toMatch(/^log .*default cadence off/);
    expect(lines[1]).toMatch(/^warn .*default cadence ON.*60 s/);
  });
});

describe('loadAgentScheduleConfig (SEN-71)', () => {
  it('defaults: poll 15 s, 3 at once, $0.10 floor, 288 runs a day', () => {
    expect(loadAgentScheduleConfig({})).toEqual({
      pollSeconds: 15,
      maxConcurrent: 3,
      minCreditsUsd: 0.1,
      maxRunsPerDay: 288,
    });
  });

  it('reads every variable', () => {
    expect(
      loadAgentScheduleConfig({
        AGENT_SCHEDULER_POLL_SECONDS: '30',
        AGENT_SCHEDULE_MAX_CONCURRENT: '1',
        AGENT_SCHEDULE_MIN_CREDITS_USD: '0.5',
        AGENT_SCHEDULE_MAX_RUNS_PER_DAY: '24',
      }),
    ).toEqual({ pollSeconds: 30, maxConcurrent: 1, minCreditsUsd: 0.5, maxRunsPerDay: 24 });
    expect(loadAgentScheduleConfig({ AGENT_SCHEDULE_MIN_CREDITS_USD: '0' }).minCreditsUsd).toBe(0);
  });

  it.each(['0', 'off', 'OFF'])('AGENT_SCHEDULER_POLL_SECONDS=%j turns scheduling off', (value) => {
    expect(
      loadAgentScheduleConfig({ AGENT_SCHEDULER_POLL_SECONDS: value }).pollSeconds,
    ).toBeUndefined();
  });

  it.each([
    ['AGENT_SCHEDULER_POLL_SECONDS', ['4', '301', '1.5', 'fast']],
    ['AGENT_SCHEDULE_MAX_CONCURRENT', ['0', '51', '-1', 'many']],
    ['AGENT_SCHEDULE_MIN_CREDITS_USD', ['-0.1', '1001', '0.', '$1', 'ten']],
    ['AGENT_SCHEDULE_MAX_RUNS_PER_DAY', ['0', '1441', '2.5']],
  ] as const)('refuses an out-of-range or malformed %s', (name, values) => {
    for (const value of values) {
      expect(() => loadAgentScheduleConfig({ [name]: value })).toThrow(new RegExp(name));
    }
  });

  it('describes the scheduler, and which agents it runs', () => {
    const lines: string[] = [];
    const logger = { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const runner = loadAgentRunnerConfig({});
    describeAgentScheduleConfig(runner, loadAgentScheduleConfig({}), logger);
    describeAgentScheduleConfig(
      loadAgentRunnerConfig({ AGENT_TICK_SECONDS: '300' }),
      loadAgentScheduleConfig({}),
      logger,
    );
    describeAgentScheduleConfig(
      runner,
      loadAgentScheduleConfig({ AGENT_SCHEDULER_POLL_SECONDS: 'off' }),
      logger,
    );
    expect(lines[0]).toMatch(/poll every 15 s.*manually only/);
    expect(lines[1]).toMatch(/every 300 s/);
    expect(lines[2]).toMatch(/scheduler off/);
  });
});
