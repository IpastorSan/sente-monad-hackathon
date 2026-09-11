import { GATED_TOOLS } from '../tools/gate';
import { SPACING_ABORTED_MESSAGE, spaceWrites, WriteSpacer } from './write-spacing';

/** A virtual clock: `sleep` advances it instead of waiting. */
function clock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

describe('WriteSpacer', () => {
  it('runs the first write at once and the next one spacingMs after it ENDED', async () => {
    const c = clock();
    const spacer = new WriteSpacer({ spacingMs: 5_000, now: c.now, sleep: c.sleep });
    const order: string[] = [];
    const write = (name: string) => async () => {
      order.push(`${name}@${c.now()}`);
      c.advance(300); // the sign + broadcast takes 300 ms
      return name;
    };

    // Fired together, as the Tool Runner fires a turn's tool calls.
    const results = await Promise.all([spacer.run('a', write('w1')), spacer.run('a', write('w2'))]);

    expect(results).toEqual(['w1', 'w2']);
    expect(c.sleeps).toEqual([5_000]);
    expect(order).toEqual(['w1@1000000', 'w2@1005300']);
  });

  it('does not make different agents wait on each other', async () => {
    const c = clock();
    const spacer = new WriteSpacer({ spacingMs: 5_000, now: c.now, sleep: c.sleep });
    await Promise.all([
      spacer.run('a', () => Promise.resolve()),
      spacer.run('b', () => Promise.resolve()),
    ]);
    expect(c.sleeps).toEqual([]);
  });

  it('only waits out what is left of the gap', async () => {
    const c = clock();
    const spacer = new WriteSpacer({ spacingMs: 5_000, now: c.now, sleep: c.sleep });
    await spacer.run('a', () => Promise.resolve());
    c.advance(3_000);
    await spacer.run('a', () => Promise.resolve());
    c.advance(9_000);
    await spacer.run('a', () => Promise.resolve());
    expect(c.sleeps).toEqual([2_000]);
  });

  it('counts a write that failed, and passes its error through', async () => {
    const c = clock();
    const spacer = new WriteSpacer({ spacingMs: 5_000, now: c.now, sleep: c.sleep });
    await expect(spacer.run('a', () => Promise.reject(new Error('reverted')))).rejects.toThrow(
      'reverted',
    );
    await spacer.run('a', () => Promise.resolve());
    expect(c.sleeps).toEqual([5_000]);
  });

  it('gives up without running the write when the run aborts while it waits', async () => {
    const spacer = new WriteSpacer({ spacingMs: 60_000 });
    await spacer.run('a', () => Promise.resolve());
    const abort = new AbortController();
    const task = jest.fn(() => Promise.resolve('sent'));
    const waiting = spacer.run('a', task, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow('aborted');
    expect(task).not.toHaveBeenCalled();
  });
});

describe('spaceWrites', () => {
  const byName = (tools: readonly { name: string }[], name: string) =>
    tools.find((t) => t.name === name);

  it('wraps only the signing writes: reads and record_thesis pass through as they are', () => {
    const spaced = spaceWrites(GATED_TOOLS, new WriteSpacer({ spacingMs: 5_000 }));
    for (const original of GATED_TOOLS) {
      const same = byName(spaced, original.name) === original;
      const signing = original.kind === 'write' && original.name !== 'record_thesis';
      expect([original.name, same]).toEqual([original.name, !signing]);
    }
  });

  it('is the identity at spacing 0', () => {
    const spaced = spaceWrites(GATED_TOOLS, new WriteSpacer({ spacingMs: 0 }));
    spaced.forEach((tool, i) => expect(tool).toBe(GATED_TOOLS[i]));
  });

  it('answers the model, instead of throwing, when the run aborted during the wait', async () => {
    const spacer = new WriteSpacer({ spacingMs: 60_000 });
    await spacer.run('11111111-1111-4111-8111-111111111111', () => Promise.resolve());
    const abort = new AbortController();
    const cancel = byName(spaceWrites(GATED_TOOLS, spacer, abort.signal), 'cancel_order')!;
    const ctx = { agent: { id: '11111111-1111-4111-8111-111111111111' } } as never;
    const outcome = (cancel as (typeof GATED_TOOLS)[number]).invoke(ctx, {});
    abort.abort();
    await expect(outcome).resolves.toEqual({ ok: false, message: SPACING_ABORTED_MESSAGE });
  });
});
