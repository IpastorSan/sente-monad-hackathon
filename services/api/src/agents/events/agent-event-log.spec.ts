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

  it('pages forward without losing an event: three pages, every seq exactly once', async () => {
    const log = new InMemoryAgentEventLog();
    for (let i = 0; i < 7; i += 1) await log.append({ agentId: 'a', kind: 'order', detail: {} });

    // The client is six events behind and reads two at a time. Taking the LAST
    // two matches after the cursor — as this did — would answer [6,7] to the
    // first call and skip 1..5 for good.
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 3; page += 1) {
      const events = await log.list('a', { afterSeq: cursor ?? 0, limit: 3 });
      seen.push(...events.map((e) => e.seq));
      cursor = events.at(-1)?.seq ?? cursor;
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // And the cursor has landed on the end of the log, not past a gap.
    expect(await log.list('a', { afterSeq: cursor, limit: 3 })).toEqual([]);

    // With no cursor, `limit` still means the most recent page: that is what a
    // screen opening on an agent's history asks for.
    expect((await log.list('a', { limit: 3 })).map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(await log.list('a', { limit: 0 })).toEqual([]);
  });

  it('hands out frozen events rather than a copy per read', async () => {
    const log = new InMemoryAgentEventLog();
    await log.append({ agentId: 'a', kind: 'order', detail: { nested: { size: '1' } } });
    const [stored] = await log.list('a');

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored!.detail)).toBe(true);
    expect(Object.isFrozen(stored!.detail['nested'])).toBe(true);
    // Frozen, so a caller cannot edit the log by editing what it read.
    expect(() => {
      (stored as { seq: number }).seq = 99;
    }).toThrow();
    expect((await log.list('a'))[0]!.seq).toBe(1);
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
