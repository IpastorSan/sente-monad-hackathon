import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAddress } from 'viem';

import { FileAgentEventLog } from '../../agents/events/file-agent-event-log';
import { SqliteAgentEventLog } from '../../agents/events/sqlite-agent-event-log';
import { FileRunTranscriptStore } from '../../agents/runner/transcript/file-run-transcript-store';
import { SqliteRunTranscriptStore } from '../../agents/runner/transcript/sqlite-run-transcript-store';
import { FileAgentStore } from '../../agents/store/file-agent-store';
import { SqliteAgentStore } from '../../agents/store/sqlite-agent-store';
import { testAgent } from '../../agents/tools/testing/agent-fixture';
import { FileAgentSecretStore } from '../../agents/venues/file-agent-secret-store';
import { SqliteAgentSecretStore } from '../../agents/venues/sqlite-agent-secret-store';
import { FileCreditKeyStore } from '../../credits/store/file-credit-key-store';
import { SqliteCreditKeyStore } from '../../credits/store/sqlite-credit-key-store';
import { FileCreatorFeeLedger } from '../../fees/creator-fees';
import { SqliteCreatorFeeLedger } from '../../fees/sqlite-creator-fees';
import { FileProfileStore } from '../../profile/profile.store';
import { SqliteProfileStore } from '../../profile/sqlite-profile.store';
import { SqliteStarterKitStore } from '../../starter-kit/sqlite-starter-kit.store';
import { FileStarterKitStore, hashIp } from '../../starter-kit/starter-kit.store';
import { FileUserVenueSecretStore } from '../../trade/file-user-venue-secrets';
import { SqliteUserVenueSecretStore } from '../../trade/sqlite-user-venue-secrets';
import { SqliteValueHistoryStore } from '../../portfolio/history/sqlite-value-history-store';
import { FileValueHistoryStore } from '../../portfolio/history/value-history.store';
import { SqliteWatcherStore } from '../../agents/watchers/sqlite-watcher-store';
import { testWatcherSet } from '../../agents/watchers/testing/watcher-set';
import { FileWatcherStore } from '../../agents/watchers/watcher-store';
import { FileUserWalletRegistry } from '../../wallet/store/file-user-wallet-registry';
import { SqliteUserWalletRegistry } from '../../wallet/store/sqlite-user-wallet-registry';
import { acquireStateDirLock, StateDirLockedError } from '../state-dir-lock';
import { SenteDb, senteDbPath } from './sente-db';
import { contentHash, importStateToSqlite, STORE_IMPORTS } from './state-import';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-import-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DEVICE_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(52) + '==';
const SECRETS_KEY = Buffer.alloc(32, 7);
const OR_KEY = 'sk-or-v1-FAKE-do-not-leak';
const PERPL_KEY = 'perpl-api-key-FAKE-do-not-leak';

/** A STATE_DIR as the file backend leaves it: two agents, one wallet binding. */
async function writeFiles() {
  const agents = new FileAgentStore(join(dir, 'agents.json'));
  const first = testAgent({ gasFunding: { funded: true, amountWei: 10n ** 17n } });
  const second = testAgent({
    id: '22222222-2222-4222-8222-222222222222',
    mcpTokenHash: 'b'.repeat(64),
    userId: 'bob',
    status: 'revoked',
    createdAt: new Date(Date.now() + 1_000),
  });
  await agents.insert(first);
  await agents.insert(second);

  const wallets = new FileUserWalletRegistry(join(dir, 'user-wallets.json'));
  await wallets.bind({
    userId: 'alice',
    walletId: 'wallet00000000000000test',
    address: getAddress(`0x${'9'.repeat(40)}`),
    ownerQuorumId: 'quorum00000000000000test',
    devicePublicKey: DEVICE_KEY,
  });

  // SEN-205 phase 2: the small stores and the three sealed under AGENT_SECRETS_KEY.
  new FileProfileStore(join(dir, 'profiles.json')).set('alice', { name: 'Lucky Crab' }, new Date());
  const kits = new FileStarterKitStore(join(dir, 'starter-kits.json'));
  kits.claim('alice', getAddress(`0x${'a'.repeat(40)}`), 50, new Date(), {
    ip: '203.0.113.7',
    cap: 5,
  });
  kits.update('alice', { status: 'sent' }, new Date());
  const fees = new FileCreatorFeeLedger(join(dir, 'creator-fees.json'));
  fees.accrue({
    creatorUserId: 'alice',
    agentId: 'fork-1',
    sourceAgentId: 'source-1',
    asset: 'WETH',
    decimals: 18,
    feeAtoms: 10n ** 30n,
    txHash: `0x${'1'.repeat(64)}`,
  });
  await new FileCreditKeyStore(join(dir, 'credit-keys.json'), SECRETS_KEY).claim({
    userId: 'alice',
    hash: 'h1',
    key: OR_KEY,
  });
  await new FileAgentSecretStore(join(dir, 'agent-secrets.json'), SECRETS_KEY).putPerplCredentials(
    first.id,
    { apiKey: PERPL_KEY, secretKey: new Uint8Array(32).fill(5) },
  );
  const venue = new FileUserVenueSecretStore(join(dir, 'user-venue-secrets.json'), SECRETS_KEY);
  await venue.putPerplTradeToken('alice', 'trade-token');
  const watchers = new FileWatcherStore(join(dir, 'agent-watchers.json'));
  const watcherSet = testWatcherSet(first.id);
  watchers.put(watcherSet);
  return { agents: [first, second], watcherSet };
}

const SMALL_STORES = [
  'profiles.json',
  'starter-kits.json',
  'creator-fees.json',
  'credit-keys.json',
  'agent-secrets.json',
  'user-venue-secrets.json',
];

const quiet = { warn: () => {}, error: () => {} };
const LOG_FILES = ['agent-events.jsonl', 'agent-runs.jsonl', 'value-history.jsonl'];

/** The three append-only logs as the file backend leaves them. */
async function writeLogs() {
  const events = new FileAgentEventLog(join(dir, 'agent-events.jsonl'), { logger: quiet });
  await events.append({ agentId: 'a', runId: 'r1', kind: 'thesis', detail: { n: 1n } });
  await events.append({ agentId: 'b', kind: 'deposit', detail: {} });
  await events.append({ agentId: 'a', kind: 'refusal', layer: 'sente', detail: {} });
  events.close();

  const runs = new FileRunTranscriptStore(join(dir, 'agent-runs.jsonl'), { logger: quiet });
  runs.start({ runId: 'r1', agentId: 'a', trigger: 'manual', model: 'm', startedAt: 1 });
  runs.start({ runId: 'r2', agentId: 'b', trigger: 'manual', model: 'm', startedAt: 2 });
  runs.append('r1', { kind: 'note', text: 'one' }, 3);
  runs.append('r2', { kind: 'note', text: 'two' }, 4);
  runs.append('r1', { kind: 'note', text: 'three' }, 5);
  runs.close();

  const values = new FileValueHistoryStore(join(dir, 'value-history.jsonl'), { logger: quiet });
  values.append('user', 'alice', { at: 2, usd: '2' });
  values.append('user', 'alice', { at: 1, usd: '1' });
  values.append('user', 'alice', { at: 2, usd: '2.5', partial: true });
  values.append('agent', 'a', { at: 1, usd: '7' });
  values.close();
}

function readLogs(): string[] {
  return LOG_FILES.map((file) => readFileSync(join(dir, file), 'utf8'));
}

describe('importStateToSqlite', () => {
  it('copies every store into sente.db and verifies it record by record', async () => {
    const { agents, watcherSet } = await writeFiles();
    const before = {
      agents: readFileSync(join(dir, 'agents.json'), 'utf8'),
      wallets: readFileSync(join(dir, 'user-wallets.json'), 'utf8'),
    };
    const smallBefore = SMALL_STORES.map((file) => readFileSync(join(dir, file), 'utf8'));

    const reports = await importStateToSqlite(dir);

    expect(reports.map((r) => [r.name, r.fileCount, r.dbCount, r.ok])).toEqual([
      ['agents', 2, 2, true],
      ['user_wallets', 1, 1, true],
      ['profiles', 1, 1, true],
      ['starter_kits', 1, 1, true],
      ['creator_fees', 1, 1, true],
      ['credit_keys', 1, 1, true],
      ['agent_secrets', 1, 1, true],
      ['user_venue_secrets', 1, 1, true],
      ['agent_events', undefined, 0, true],
      ['agent_runs', undefined, 0, true],
      ['value_history', undefined, 0, true],
      ['agent_watchers', 1, 1, true],
    ]);
    expect(SMALL_STORES.map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(smallBefore);
    for (const report of reports.filter((r) => r.fileCount !== undefined)) {
      expect(report.fileHash).toBe(report.dbHash);
      expect(report).toMatchObject({ differs: 0, missing: 0, dbOnly: 0 });
    }

    // The files are the rollback; the import must not touch them.
    expect(readFileSync(join(dir, 'agents.json'), 'utf8')).toBe(before.agents);
    expect(readFileSync(join(dir, 'user-wallets.json'), 'utf8')).toBe(before.wallets);

    const db = SenteDb.open(senteDbPath(dir));
    try {
      const store = new SqliteAgentStore(db);
      expect(await store.listAll()).toEqual(agents);
      expect((await store.get(agents[0]!.id))!.gasFunding!.amountWei).toBe(10n ** 17n);
      expect((await new SqliteUserWalletRegistry(db).find('alice'))?.walletId).toBe(
        'wallet00000000000000test',
      );

      // The small stores read back through their SQLite implementations.
      expect(new SqliteProfileStore(db).get('alice')).toEqual({
        name: 'Lucky Crab',
        avatarSeed: null,
      });
      expect(new SqliteStarterKitStore(db).find('alice')).toMatchObject({
        status: 'sent',
        ipHash: hashIp('203.0.113.7'),
      });
      expect(new SqliteCreatorFeeLedger(db).totals('alice')[0]!.owedAtoms).toBe(3n * 10n ** 29n);
      // Sealed rows were copied without the key, and open under it.
      expect((await new SqliteCreditKeyStore(db, SECRETS_KEY).find('alice'))?.key).toBe(OR_KEY);
      const perpl = await new SqliteAgentSecretStore(db, SECRETS_KEY).getPerplCredentials(
        agents[0]!.id,
      );
      expect(perpl?.apiKey).toBe(PERPL_KEY);
      await expect(
        new SqliteUserVenueSecretStore(db, SECRETS_KEY).getPerplTradeToken('alice'),
      ).resolves.toBe('trade-token');
      expect(new SqliteWatcherStore(db).get(watcherSet.agentId)).toEqual(watcherSet);
    } finally {
      db.close();
    }
  });

  it('is idempotent, and reports records the API wrote under sqlite since as table-only', async () => {
    await writeFiles();
    await importStateToSqlite(dir);

    const db = SenteDb.open(senteDbPath(dir));
    try {
      await new SqliteAgentStore(db).insert(
        testAgent({ id: '33333333-3333-4333-8333-333333333333', mcpTokenHash: 'c'.repeat(64) }),
      );
    } finally {
      db.close();
    }

    const reports = await importStateToSqlite(dir);
    expect(reports[0]).toMatchObject({
      name: 'agents',
      fileCount: 2,
      dbCount: 3,
      matched: 2,
      dbOnly: 1,
      ok: true,
    });
    expect(reports[1]).toMatchObject({ name: 'user_wallets', fileCount: 1, dbCount: 1, ok: true });
  });

  it('imports nothing for a store whose file does not exist, and says so', async () => {
    const reports = await importStateToSqlite(dir);
    expect(reports.map((r) => [r.name, r.fileCount, r.dbCount, r.ok])).toEqual(
      STORE_IMPORTS.map((s) => [s.name, undefined, 0, true]),
    );
  });

  it('refuses while another process holds the STATE_DIR lock', async () => {
    await writeFiles();
    // Another host's lock is never taken over, whatever its pid, so this cannot
    // depend on which pids happen to be alive on the box running the suite.
    const lock = acquireStateDirLock(dir, { hostname: 'another-host' });
    try {
      await expect(importStateToSqlite(dir)).rejects.toThrow(StateDirLockedError);
    } finally {
      lock.release();
    }
  });

  it('releases the lock when it is done, so the API can start', async () => {
    await importStateToSqlite(dir);
    acquireStateDirLock(dir).release();
  });

  it('covers every converted store once', () => {
    const names = STORE_IMPORTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'agents',
      'user_wallets',
      'profiles',
      'starter_kits',
      'creator_fees',
      'credit_keys',
      'agent_secrets',
      'user_venue_secrets',
      'agent_events',
      'agent_runs',
      'value_history',
      'agent_watchers',
    ]);
  });
});

describe('importStateToSqlite, the append-only logs', () => {
  it('copies each log in order and the SQLite stores serve what the file stores did', async () => {
    await writeLogs();
    const before = readLogs();

    const reports = await importStateToSqlite(dir);
    const byName = new Map(reports.map((r) => [r.name, r]));
    // Events: 3; runs: 2 starts + 3 entries; snapshots: 4.
    for (const [name, count] of [
      ['agent_events', 3],
      ['agent_runs', 5],
      ['value_history', 4],
    ] as const) {
      expect(byName.get(name)).toMatchObject({
        fileCount: count,
        dbCount: count,
        matched: count,
        inOrder: true,
        ok: true,
      });
      expect(byName.get(name)!.fileHash).toBe(byName.get(name)!.dbHash);
    }
    expect(readLogs()).toEqual(before);

    const fileEvents = new FileAgentEventLog(join(dir, 'agent-events.jsonl'), { logger: quiet });
    const fileRuns = new FileRunTranscriptStore(join(dir, 'agent-runs.jsonl'), { logger: quiet });
    const fileValues = new FileValueHistoryStore(join(dir, 'value-history.jsonl'), {
      logger: quiet,
    });
    const db = SenteDb.open(senteDbPath(dir));
    try {
      const events = new SqliteAgentEventLog(db);
      expect(await events.list('a')).toEqual(await fileEvents.list('a'));
      expect(await events.list('b')).toEqual(await fileEvents.list('b'));
      // seq carries on from the imported events.
      expect((await events.append({ agentId: 'a', kind: 'order', detail: {} })).seq).toBe(4);

      const runs = new SqliteRunTranscriptStore(db);
      expect(runs.list('a')).toEqual(fileRuns.list('a'));
      expect(runs.read('a', 'r1')).toEqual(fileRuns.read('a', 'r1'));

      const values = new SqliteValueHistoryStore(db);
      expect(values.list('user', 'alice')).toEqual(fileValues.list('user', 'alice'));
      expect(values.list('agent', 'a')).toEqual(fileValues.list('agent', 'a'));
    } finally {
      db.close();
      fileEvents.close();
      fileRuns.close();
      fileValues.close();
    }
  });

  it('re-runs without duplicating a line, and keeps what the API appended since', async () => {
    await writeLogs();
    await importStateToSqlite(dir);
    const db = SenteDb.open(senteDbPath(dir));
    try {
      await new SqliteAgentEventLog(db).append({ agentId: 'a', kind: 'order', detail: {} });
      new SqliteValueHistoryStore(db).append('user', 'alice', { at: 2, usd: '3' });
    } finally {
      db.close();
    }

    const reports = new Map((await importStateToSqlite(dir)).map((r) => [r.name, r]));
    expect(reports.get('agent_events')).toMatchObject({ dbCount: 4, dbOnly: 1, ok: true });
    expect(reports.get('agent_runs')).toMatchObject({ dbCount: 5, dbOnly: 0, ok: true });
    expect(reports.get('value_history')).toMatchObject({ dbCount: 5, dbOnly: 1, ok: true });
  });

  it('carries what the event cap dropped, and leaves a torn last line where it is', async () => {
    const lines = [
      JSON.stringify({ v: 1, truncated: { a: { evicted: 5, newestEvictedAt: 50 } } }),
      JSON.stringify({ v: 1, e: { seq: 9, agentId: 'a', at: 90, kind: 'order', detail: {} } }),
    ];
    writeFileSync(join(dir, 'agent-events.jsonl'), `${lines.join('\n')}\n`);
    appendFileSync(join(dir, 'agent-events.jsonl'), '{"v":1,"e":{"seq":10,"ag');
    const before = readFileSync(join(dir, 'agent-events.jsonl'), 'utf8');

    const [report] = (await importStateToSqlite(dir)).filter((r) => r.name === 'agent_events');
    // One event and one agent's dropped count.
    expect(report).toMatchObject({ fileCount: 2, dbCount: 2, ok: true });
    expect(readFileSync(join(dir, 'agent-events.jsonl'), 'utf8')).toBe(before);

    const db = SenteDb.open(senteDbPath(dir));
    try {
      const events = new SqliteAgentEventLog(db);
      expect(await events.truncation('a')).toEqual({ evicted: 5, newestEvictedAt: 50 });
      expect((await events.append({ agentId: 'a', kind: 'order', detail: {} })).seq).toBe(10);
    } finally {
      db.close();
    }
  });

  it('refuses a log with a corrupt line before its end', async () => {
    writeFileSync(join(dir, 'value-history.jsonl'), 'garbage\n{"v":1}\n');
    await expect(importStateToSqlite(dir)).rejects.toThrow(/line 1 is not a readable/);
  });
});

describe('contentHash', () => {
  it('ignores record order and key order, and separates a bigint from its number', () => {
    const a = [
      { id: 'b', v: 2n, nested: { y: 1, x: 2 } },
      { id: 'a', v: 1n },
    ];
    const b = [
      { id: 'a', v: 1n },
      { nested: { x: 2, y: 1 }, v: 2n, id: 'b' },
    ];
    const key = (r: { id: string }) => r.id;
    expect(contentHash(a, key)).toBe(contentHash(b, key));
    expect(contentHash([{ id: 'a', v: 1n }], key)).not.toBe(contentHash([{ id: 'a', v: 1 }], key));
  });
});
