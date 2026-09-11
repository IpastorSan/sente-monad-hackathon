import {
  AGENT_RUNNER_DEFAULTS,
  describeAgentRunnerConfig,
  loadAgentRunnerConfig,
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

  it('describes the scheduler loudly when it is on', () => {
    const lines: string[] = [];
    const logger = {
      log: (m: string) => lines.push(`log ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
    };
    describeAgentRunnerConfig(loadAgentRunnerConfig({}), logger);
    describeAgentRunnerConfig(loadAgentRunnerConfig({ AGENT_TICK_SECONDS: '60' }), logger);
    expect(lines[0]).toMatch(/^log .*scheduler off/);
    expect(lines[1]).toMatch(/^warn .*scheduler ON.*60 s/);
  });
});
