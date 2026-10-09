import { Test } from '@nestjs/testing';

import { AgentsModule } from '../agents.module';
import { AGENT_EVENTS } from '../events/agent-event-log';
import { AgentRunScheduler } from '../runner/agent-run.scheduler';
import { WatcherService } from '../watchers/watcher.service';
import { WatchersController } from '../watchers/watchers.controller';
import { AgentTools } from './context';
import { McpHttp } from './mcp-http';
import { loadAgentToolsConfig } from './tools.config';

describe('loadAgentToolsConfig', () => {
  it('keeps the pre-check on unless told otherwise', () => {
    expect(loadAgentToolsConfig({})).toEqual({ precheck: true });
    expect(loadAgentToolsConfig({ AGENT_PRECHECK: 'on' })).toEqual({ precheck: true });
    expect(loadAgentToolsConfig({ AGENT_PRECHECK: ' ' })).toEqual({ precheck: true });
  });

  it('turns it off outside production only', () => {
    expect(loadAgentToolsConfig({ AGENT_PRECHECK: 'off', NODE_ENV: 'development' })).toEqual({
      precheck: false,
    });
    expect(loadAgentToolsConfig({ AGENT_PRECHECK: 'OFF' })).toEqual({ precheck: false });
    expect(() => loadAgentToolsConfig({ AGENT_PRECHECK: 'off', NODE_ENV: 'production' })).toThrow(
      /AGENT_PRECHECK=off is refused when NODE_ENV=production/,
    );
  });

  it('refuses a value it does not know, rather than guessing', () => {
    expect(() => loadAgentToolsConfig({ AGENT_PRECHECK: 'false' })).toThrow(/"on" or "off"/);
  });
});

describe('AgentsModule boot', () => {
  const saved = {
    AGENT_PRECHECK: process.env['AGENT_PRECHECK'],
    NODE_ENV: process.env['NODE_ENV'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses to boot with AGENT_PRECHECK=off when NODE_ENV=production', async () => {
    process.env['AGENT_PRECHECK'] = 'off';
    process.env['NODE_ENV'] = 'production';
    await expect(Test.createTestingModule({ imports: [AgentsModule] }).compile()).rejects.toThrow(
      /AGENT_PRECHECK=off is refused/,
    );
  });

  it('boots by default with the tools, the event log and /mcp wired', async () => {
    delete process.env['AGENT_PRECHECK'];
    const moduleRef = await Test.createTestingModule({ imports: [AgentsModule] }).compile();
    expect(moduleRef.get(AgentTools).precheck).toBe(true);
    expect(moduleRef.get(AGENT_EVENTS)).toBeDefined();
    expect(moduleRef.get(McpHttp)).toBeInstanceOf(McpHttp);
    // SEN-182: one WatcherService, shared by the tools, the scheduler and the owner routes.
    const watchers = moduleRef.get(WatcherService);
    expect(watchers).toBeInstanceOf(WatcherService);
    expect((moduleRef.get(AgentRunScheduler) as unknown as { watchers: unknown }).watchers).toBe(
      watchers,
    );
    // Request-scoped through Auth, like every agent controller.
    expect(await moduleRef.resolve(WatchersController)).toBeInstanceOf(WatchersController);
    await moduleRef.close();
  });
});
