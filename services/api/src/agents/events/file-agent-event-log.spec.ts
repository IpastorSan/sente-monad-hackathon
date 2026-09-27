import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryAgentEventLog, type AgentEventLog } from './agent-event-log';
import { FileAgentEventLog } from './file-agent-event-log';

const quiet = { warn: jest.fn(), error: jest.fn() };

let dir: string;
let path: string;
const open: FileAgentEventLog[] = [];

function fileLog(maxPerAgent?: number): FileAgentEventLog {
  const log = new FileAgentEventLog(path, {
    logger: quiet,
    ...(maxPerAgent === undefined ? {} : { maxPerAgent }),
  });
  open.push(log);
  return log;
}

function lines(): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-events-'));
  path = join(dir, 'agent-events.jsonl');
  quiet.warn.mockClear();
  quiet.error.mockClear();
});

afterEach(() => {
  for (const log of open.splice(0)) log.close();
  rmSync(dir, { recursive: true, force: true });
});

// The same `list` table the in-memory spec runs, over both implementations, so
// the file-backed log cannot drift from the semantics the routes rely on.
describe.each<[string, () => AgentEventLog]>([
  ['InMemoryAgentEventLog', () => new InMemoryAgentEventLog()],
  ['FileAgentEventLog', () => fileLog()],
])('%s list semantics', (_name, make) => {
  it('stamps seq and at, and filters by run, kind and position', async () => {
    const log = make();
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
    expect((await log.list('a')).map((e) => e.kind)).toEqual(['thesis', 'refusal', 'order']);
    expect((await log.list('a', { runId: 'r1' })).map((e) => e.seq)).toEqual([1, 2]);
    expect((await log.list('a', { kind: 'refusal' }))[0]!.layer).toBe('sente');
    expect((await log.list('a', { afterSeq: 2 }))[0]!.at).toBe(42);
    expect((await log.list('a', { limit: 1 })).map((e) => e.seq)).toEqual([3]);
    expect(await log.list('nobody')).toEqual([]);
  });

  it('pages forward from a cursor and backward without one', async () => {
    const log = make();
    for (let i = 0; i < 7; i += 1) await log.append({ agentId: 'a', kind: 'order', detail: {} });

    expect((await log.list('a', { afterSeq: 0, limit: 3 })).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await log.list('a', { afterSeq: 6, limit: 3 })).map((e) => e.seq)).toEqual([7]);
    expect((await log.list('a', { limit: 3 })).map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(await log.list('a', { limit: 0 })).toEqual([]);
  });

  it('rejects a refusal without a layer, and a layer on anything else', async () => {
    const log = make();
    await expect(log.append({ agentId: 'a', kind: 'refusal', detail: {} })).rejects.toThrow(
      /layer/,
    );
    await expect(
      log.append({ agentId: 'a', kind: 'order', layer: 'enclave', detail: {} }),
    ).rejects.toThrow(/layer/);
  });
});

describe('FileAgentEventLog', () => {
  it('keeps events across a restart and carries seq on', async () => {
    const first = fileLog();
    await first.append({ agentId: 'a', kind: 'order', detail: { amountAtoms: 25n } });
    await first.append({ agentId: 'b', kind: 'fill', detail: {} });
    first.close();

    const second = fileLog();
    expect(second.size).toBe(2);
    const [stored] = await second.list('a');
    expect(stored).toMatchObject({ seq: 1, kind: 'order', detail: { amountAtoms: '25' } });
    expect(Object.isFrozen(stored)).toBe(true);

    // A phone holding `afterSeq: 2` from before the restart sees only what is new.
    const next = await second.append({ agentId: 'a', kind: 'thesis', detail: {} });
    expect(next.seq).toBe(3);
    expect((await second.list('a', { afterSeq: 2 })).map((e) => e.seq)).toEqual([3]);
  });

  it('does not write a rejected event', async () => {
    const log = fileLog();
    await expect(log.append({ agentId: 'a', kind: 'refusal', detail: {} })).rejects.toThrow(
      /layer/,
    );
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('cuts off a torn last line with a warning and appends after it', async () => {
    const first = fileLog();
    await first.append({ agentId: 'a', kind: 'order', detail: {} });
    first.close();
    appendFileSync(path, '{"v":1,"e":{"seq":2,"agentId":"a","ki');

    const second = fileLog();
    expect(second.size).toBe(1);
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringMatching(/torn/));
    await second.append({ agentId: 'a', kind: 'fill', detail: {} });
    second.close();

    expect(lines().map((line) => (JSON.parse(line) as { e: { seq: number } }).e.seq)).toEqual([
      1, 2,
    ]);
  });

  it('refuses to boot on a corrupt line before the end', async () => {
    const first = fileLog();
    await first.append({ agentId: 'a', kind: 'order', detail: {} });
    await first.append({ agentId: 'a', kind: 'order', detail: {} });
    first.close();
    const [one, two] = lines();
    writeFileSync(path, `${one}\n{"v":1,"e":{"se\n${two}\n`);

    expect(() => fileLog()).toThrow(/line 2 is not a readable event/);
  });

  it('refuses to boot on another format version', () => {
    writeFileSync(path, '{"v":2,"e":{"seq":1,"agentId":"a","kind":"order","detail":{}}}\n');
    expect(() => fileLog()).toThrow(/not a v1 event/);
  });

  it('holds the per-agent cap after a reload', async () => {
    const first = fileLog(2);
    for (let i = 0; i < 4; i += 1) await first.append({ agentId: 'a', kind: 'order', detail: {} });
    await first.append({ agentId: 'b', kind: 'order', detail: {} });
    first.close();

    const second = fileLog(2);
    expect(second.size).toBe(3);
    expect((await second.list('a')).map((e) => e.seq)).toEqual([3, 4]);
    expect((await second.list('b')).map((e) => e.seq)).toEqual([5]);
  });

  it('compacts at boot once the file holds far more than it keeps', async () => {
    const first = fileLog(1);
    for (let i = 0; i < 1_010; i += 1) {
      await first.append({ agentId: 'a', kind: 'order', detail: {} });
    }
    first.close();
    expect(lines()).toHaveLength(1_010);

    const second = fileLog(1);
    expect(lines()).toHaveLength(1);
    expect((await second.list('a')).map((e) => e.seq)).toEqual([1_010]);
    expect((await second.append({ agentId: 'a', kind: 'fill', detail: {} })).seq).toBe(1_011);
  });

  it('resolves an append whose write fails, and logs it', async () => {
    const log = fileLog();
    log.close();
    const stored = await log.append({ agentId: 'a', kind: 'order', detail: {} });
    expect(stored.seq).toBe(1);
    expect(quiet.error).toHaveBeenCalledWith(expect.stringMatching(/not written/));
    expect(await log.list('a')).toHaveLength(1);
  });
});
