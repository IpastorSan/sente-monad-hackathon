import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAddress } from 'viem';

import { FileAgentStore } from '../../agents/store/file-agent-store';
import { SqliteAgentStore } from '../../agents/store/sqlite-agent-store';
import { testAgent } from '../../agents/tools/testing/agent-fixture';
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
  return { agents: [first, second] };
}

describe('importStateToSqlite', () => {
  it('copies every store into sente.db and verifies it record by record', async () => {
    const { agents } = await writeFiles();
    const before = {
      agents: readFileSync(join(dir, 'agents.json'), 'utf8'),
      wallets: readFileSync(join(dir, 'user-wallets.json'), 'utf8'),
    };

    const reports = await importStateToSqlite(dir);

    expect(reports.map((r) => [r.name, r.fileCount, r.dbCount, r.ok])).toEqual([
      ['agents', 2, 2, true],
      ['user_wallets', 1, 1, true],
    ]);
    for (const report of reports) {
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
    expect(reports.map((r) => [r.name, r.fileCount, r.dbCount, r.ok])).toEqual([
      ['agents', undefined, 0, true],
      ['user_wallets', undefined, 0, true],
    ]);
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
    expect(names).toEqual(['agents', 'user_wallets']);
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
