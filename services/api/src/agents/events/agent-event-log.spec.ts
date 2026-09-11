import { InMemoryAgentEventLog } from './agent-event-log';

describe('InMemoryAgentEventLog', () => {
  it('stamps seq and at, and filters by run, kind and position', async () => {
    const log = new InMemoryAgentEventLog();
    await log.append({ agentId: 'a', runId: 'r1', kind: 'thesis', detail: { market: 'MON-USDC' } });
    const refusal = await log.append({
      agentId: 'a',
      runId: 'r1',
      kind: 'refusal',
      layer: 'sente',
      detail: { code: 'notional_over_cap' },
    });
    await log.append({ agentId: 'a', runId: 'r2', kind: 'order', detail: {}, at: 42 });
    await log.append({ agentId: 'b', kind: 'order', detail: {} });

    expect(refusal.seq).toBe(2);
    expect(refusal.at).toBeGreaterThan(0);
    expect((await log.list('a')).map((e) => e.kind)).toEqual(['thesis', 'refusal', 'order']);
    expect((await log.list('a', { runId: 'r1' })).map((e) => e.seq)).toEqual([1, 2]);
    expect((await log.list('a', { kind: 'refusal' }))[0]!.layer).toBe('sente');
    expect((await log.list('a', { afterSeq: 2 }))[0]!.at).toBe(42);
    expect((await log.list('a', { limit: 1 })).map((e) => e.seq)).toEqual([3]);
    expect(await log.list('nobody')).toEqual([]);
  });

  it('requires a layer on refusals, and only on refusals', async () => {
    const log = new InMemoryAgentEventLog();
    await expect(log.append({ agentId: 'a', kind: 'refusal', detail: {} })).rejects.toThrow(
      /layer/,
    );
    await expect(
      log.append({ agentId: 'a', kind: 'order', layer: 'enclave', detail: {} }),
    ).rejects.toThrow(/layer/);
  });

  it('stores JSON-safe copies and stays bounded', async () => {
    const log = new InMemoryAgentEventLog(2);
    const detail = { amountAtoms: 25_000_000n, nested: { keep: 'me' } };
    await log.append({ agentId: 'a', kind: 'order', detail });
    detail.nested.keep = 'mutated';
    const [stored] = await log.list('a');
    expect(stored!.detail).toEqual({ amountAtoms: '25000000', nested: { keep: 'me' } });

    await log.append({ agentId: 'a', kind: 'order', detail: {} });
    await log.append({ agentId: 'a', kind: 'order', detail: {} });
    expect((await log.list('a')).map((e) => e.seq)).toEqual([2, 3]);
  });
});
