import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testAgent } from '../tools/testing/agent-fixture';
import { InMemoryAgentStore, type AgentStore } from './agent-store';
import { FileAgentStore } from './file-agent-store';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-agents-'));
  path = join(dir, 'agents.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const second = (patch = {}) =>
  testAgent({
    id: '22222222-2222-4222-8222-222222222222',
    mcpTokenHash: 'b'.repeat(64),
    createdAt: new Date(Date.now() + 1_000),
    ...patch,
  });

/**
 * One table, both implementations: the file-backed store is only ever chosen by
 * `STATE_DIR`, so a behavioural difference would never show up in a spec that
 * ran against the in-memory one alone.
 */
describe.each([
  ['InMemoryAgentStore', (): AgentStore => new InMemoryAgentStore()],
  ['FileAgentStore', (): AgentStore => new FileAgentStore(path)],
])('%s', (_name, create) => {
  it('inserts and reads back', async () => {
    const store = create();
    const agent = testAgent();
    await store.insert(agent);

    expect(await store.get(agent.id)).toEqual(agent);
    expect(await store.listByUser('alice')).toEqual([agent]);
    expect(await store.listActive()).toEqual([agent]);
    expect(await store.findByMcpTokenHash(agent.mcpTokenHash)).toEqual(agent);
  });

  it('rejects a duplicate id and a duplicate token hash', async () => {
    const store = create();
    await store.insert(testAgent());

    await expect(store.insert(testAgent())).rejects.toThrow(/already exists/);
    await expect(store.insert(second({ mcpTokenHash: 'a'.repeat(64) }))).rejects.toThrow(
      /token hash collision/,
    );
  });

  it('lists a user oldest first, and only their own', async () => {
    const store = create();
    await store.insert(testAgent());
    await store.insert(second({ userId: 'bob' }));

    expect((await store.listByUser('alice')).map((a) => a.id)).toEqual([testAgent().id]);
    expect((await store.listByUser('bob')).map((a) => a.id)).toEqual([second().id]);
  });

  it('patches an agent and refuses an unknown id', async () => {
    const store = create();
    await store.insert(testAgent());

    const revoked = await store.update(testAgent().id, { status: 'revoked', policyCleared: true });
    expect(revoked.status).toBe('revoked');
    expect(await store.listActive()).toEqual([]);
    await expect(store.update('no-such-agent', { status: 'revoked' })).rejects.toThrow(/no agent/);
  });

  it('copies records in and out, so a caller cannot reach the stored state', async () => {
    const store = create();
    await store.insert(testAgent());

    const read = (await store.get(testAgent().id))!;
    (read as { name: string }).name = 'mutated';
    expect((await store.get(testAgent().id))!.name).toBe('Momentum');
  });
});

describe('FileAgentStore persistence', () => {
  it('still lists the agent with its ids after a restart — the SEN-48 criterion', async () => {
    const agent = testAgent({ erc8004AgentId: '1874' });
    await new FileAgentStore(path).insert(agent);

    const after = new FileAgentStore(path);
    expect(after.size).toBe(1);
    expect(await after.listByUser('alice')).toEqual([agent]);
    const loaded = (await after.get(agent.id))!;
    expect(loaded.walletId).toBe(agent.walletId);
    expect(loaded.policyId).toBe(agent.policyId);
    expect(loaded.erc8004AgentId).toBe('1874');
  });

  it('brings a parsed mandate back as a parsed mandate, bigint atoms and all', async () => {
    const agent = testAgent();
    await new FileAgentStore(path).insert(agent);

    const loaded = (await new FileAgentStore(path).get(agent.id))!;
    // `toEqual` already separates 1n from 1, but the atoms are the whole point
    // of storing a PARSED mandate, so say so.
    expect(loaded.mandate).toEqual(agent.mandate);
    expect(typeof loaded.mandate.perpl.maxCollateralAtoms).toBe('bigint');
    expect(
      Object.values(loaded.mandate.kuru.maxDepositAtoms).every((a) => typeof a === 'bigint'),
    ).toBe(true);
    // Not `toBeInstanceOf`: `get` hands records back through `structuredClone`,
    // so under jest's vm sandbox this Date carries the host realm's prototype
    // (the same trap `isDate` in state/json-file.ts exists for).
    expect(Object.prototype.toString.call(loaded.createdAt)).toBe('[object Date]');
    expect(loaded.createdAt.getTime()).toBe(agent.createdAt.getTime());
  });

  it('persists the gas drip, whose amount is a bigint JSON cannot hold', async () => {
    const agent = testAgent({
      gasFunding: { funded: true, txHash: `0x${'a'.repeat(64)}`, amountWei: 10n ** 17n },
    });
    await new FileAgentStore(path).insert(agent);

    const loaded = (await new FileAgentStore(path).get(agent.id))!;
    expect(loaded.gasFunding).toEqual(agent.gasFunding);
    expect(loaded.gasFunding!.amountWei).toBe(10n ** 17n);
  });

  it('writes an update through, so a revoked agent stays revoked across a restart', async () => {
    const store = new FileAgentStore(path);
    await store.insert(testAgent());
    await store.update(testAgent().id, { status: 'revoked', policyCleared: true });

    const after = new FileAgentStore(path);
    expect((await after.get(testAgent().id))!.status).toBe('revoked');
    expect(await after.listActive()).toEqual([]);
  });

  it('still finds an agent by its MCP token hash after a restart', async () => {
    const agent = testAgent();
    await new FileAgentStore(path).insert(agent);

    expect(await new FileAgentStore(path).findByMcpTokenHash(agent.mcpTokenHash)).toEqual(agent);
  });

  it('does not keep an agent it could not persist', async () => {
    writeFileSync(join(dir, 'blocked'), '');
    const store = new FileAgentStore(join(dir, 'blocked', 'agents.json'));

    await expect(store.insert(testAgent())).rejects.toThrow();
    // Live in memory and absent from disk would mean a funded agent wallet that
    // the next restart forgets.
    expect(await store.get(testAgent().id)).toBeUndefined();
    expect(await store.findByMcpTokenHash(testAgent().mcpTokenHash)).toBeUndefined();
  });
});
