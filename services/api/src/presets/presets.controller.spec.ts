/**
 * `GET /presets` and `GET /presets/:id/stats` as routes (SEN-76): the paths,
 * the guard, the 404, the wire shapes the app codes against, and the cache.
 */
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { listPresets } from '@sente/presets';

import { InMemoryAgentEventLog } from '../agents/events/agent-event-log';
import type { AgentRecord, AgentStore } from '../agents/store/agent-store';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PresetsController } from './presets.controller';

function storeOf(records: Partial<AgentRecord>[]): AgentStore & { calls: number } {
  const store = {
    calls: 0,
    listAll: () => {
      store.calls += 1;
      return Promise.resolve(records as AgentRecord[]);
    },
  };
  return store as unknown as AgentStore & { calls: number };
}

describe('PresetsController', () => {
  it('is GET /presets and GET /presets/:id/stats, behind the session guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PresetsController)).toBe('presets');
    expect(Reflect.getMetadata(PATH_METADATA, PresetsController.prototype.list)).toBe('/');
    expect(Reflect.getMetadata(PATH_METADATA, PresetsController.prototype.presetStats)).toBe(
      ':id/stats',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, PresetsController)).toEqual([SessionAuthGuard]);
  });

  it('lists every preset in catalog order, as plain JSON with a defaults render', () => {
    const controller = new PresetsController(storeOf([]), new InMemoryAgentEventLog());
    const { presets } = controller.list();

    expect(presets.map((p) => p.id)).toEqual(listPresets().map((p) => p.id));
    for (const preset of presets) {
      // No functions leak onto the wire, and JSON round-trips it unchanged.
      expect(JSON.parse(JSON.stringify(preset))).toEqual(preset);
      expect(Object.keys(preset).sort()).toEqual(
        [
          'defaults',
          'description',
          'id',
          'name',
          'params',
          'tagline',
          'tools',
          'venues',
          'version',
        ].sort(),
      );
      expect(Object.keys(preset.defaults).sort()).toEqual(
        [
          'params',
          'strategy',
          'suggestedCadenceSeconds',
          'suggestedMandate',
          'systemPrompt',
        ].sort(),
      );
      expect(Object.keys(preset.defaults.params).sort()).toEqual(
        preset.params.map((s) => s.key).sort(),
      );
      expect(preset.defaults.strategy.length).toBeGreaterThan(0);
      expect(typeof preset.defaults.suggestedMandate.maxOrderNotional).toBe('string');
    }
  });

  it('answers an unknown preset with 404 preset_not_found', async () => {
    const controller = new PresetsController(storeOf([]), new InMemoryAgentEventLog());
    const error = await controller.presetStats('nope').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      reason: 'preset_not_found',
    });
  });

  it('answers the stats shape, reading verdicts from the log, and caches it for a minute', async () => {
    const now = Date.UTC(2026, 8, 27);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const events = new InMemoryAgentEventLog();
      await events.append({
        agentId: 'a',
        kind: 'verdict',
        at: now - 1000,
        detail: { realisedPnl: '2', pnlAsset: 'USDC' },
      });
      const store = storeOf([
        {
          id: 'a',
          status: 'active',
          createdAt: new Date(now - 1000_000),
          updatedAt: new Date(now - 1000_000),
          preset: { id: 'guardian', version: 1, params: {}, customized: false },
        },
      ]);
      const controller = new PresetsController(store, events);

      const stats = await controller.presetStats('guardian');
      expect(stats).toEqual({
        presetId: 'guardian',
        window: '30d',
        running: 1,
        n: 1,
        minN: 5,
        medianPnl30d: null,
        medianReturn30d: null,
        returnN: 0,
        customized: 0,
        definition: expect.any(String) as unknown,
        notes: expect.any(Array) as unknown,
        asOf: now,
      });

      await controller.presetStats('guardian');
      expect(store.calls).toBe(1);
      spy.mockReturnValue(now + 60_000);
      await controller.presetStats('guardian');
      expect(store.calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  // SEN-137: the test above has n=1, so every median is null and a controller
  // that never handed deposits to `presetStats` would still pass it.
  it("passes each agent's own deposits through to the median return", async () => {
    const now = Date.UTC(2026, 8, 27);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const events = new InMemoryAgentEventLog();
      // P&L, capital: returns 0.1, 0.2, 0.25, 0.5 and 2 — median 0.25.
      const rows: [string, string][] = [
        ['1', '10'],
        ['4', '20'],
        ['10', '40'],
        ['40', '80'],
        ['20', '10'],
      ];
      const records: Partial<AgentRecord>[] = [];
      for (const [i, [pnl, capital]] of rows.entries()) {
        const agentId = `g${i}`;
        await events.append({
          agentId,
          kind: 'deposit',
          at: now - 40 * 86_400_000,
          detail: { asset: 'USDC', amount: capital },
        });
        await events.append({
          agentId,
          kind: 'verdict',
          at: now - 1000,
          detail: { realisedPnl: pnl, pnlAsset: 'USDC' },
        });
        records.push({
          id: agentId,
          status: 'active',
          createdAt: new Date(now - 50 * 86_400_000),
          updatedAt: new Date(now - 50 * 86_400_000),
          preset: { id: 'guardian', version: 1, params: {}, customized: false },
        });
      }
      // Another preset's agent: its deposit must not become g0's capital.
      await events.append({
        agentId: 'other',
        kind: 'deposit',
        at: now - 40 * 86_400_000,
        detail: { asset: 'USDC', amount: '1000' },
      });

      const stats = await new PresetsController(storeOf(records), events).presetStats('guardian');

      // Without the deposits, returnN is 0 and the median return null.
      expect(stats).toMatchObject({
        n: 5,
        returnN: 5,
        medianPnl30d: '10',
        medianReturn30d: '0.25',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("says when the log has dropped an agent's oldest events, rather than dividing by what is left (SEN-129)", async () => {
    const now = Date.UTC(2026, 8, 27);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      // A cap of 2: the 100 USDC deposit is evicted by the two events after it.
      const events = new InMemoryAgentEventLog(2);
      await events.append({
        agentId: 'a',
        kind: 'deposit',
        at: now - 40 * 86_400_000,
        detail: { asset: 'USDC', amount: '100' },
      });
      await events.append({
        agentId: 'a',
        kind: 'deposit',
        at: now - 35 * 86_400_000,
        detail: { asset: 'USDC', amount: '1' },
      });
      await events.append({
        agentId: 'a',
        kind: 'verdict',
        at: now - 1000,
        detail: { realisedPnl: '2', pnlAsset: 'USDC' },
      });
      const store = storeOf([
        {
          id: 'a',
          status: 'active',
          createdAt: new Date(now - 50 * 86_400_000),
          updatedAt: new Date(now - 50 * 86_400_000),
          preset: { id: 'guardian', version: 1, params: {}, customized: false },
        },
      ]);

      const stats = await new PresetsController(store, events).presetStats('guardian');

      // 2 on 1 deposited would be a 200 % return; the agent is left out instead.
      expect(stats.returnN).toBe(0);
      expect(stats.notes.join(' ')).toContain('oldest events of 1 of 1 agents');
    } finally {
      spy.mockRestore();
    }
  });
});
