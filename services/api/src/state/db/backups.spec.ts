import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SenteDbBackups, type SenteDbLease } from '../state.module';
import { backupConfig, backupFileName, pruneBackups, takeBackup } from './backups';
import { SenteDb, senteDbPath } from './sente-db';
import { openedDbs } from './testing/opened-dbs';

let dir: string;
let backups: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-backups-'));
  backups = join(dir, 'backups');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** A database with one row in it, so a restored copy can be told apart from an empty one. */
function seeded(): SenteDb {
  const db = dbs.open(senteDbPath(dir));
  db.exec("INSERT INTO agent_watchers (agent_id, updated_at, data) VALUES ('a', 'now', '{}')");
  return db;
}

const at = (iso: string) => new Date(iso);

describe('backupConfig', () => {
  it('defaults to every six hours, keeping eight', () => {
    expect(backupConfig({})).toEqual({ intervalMinutes: 360, keep: 8 });
  });

  it('reads both, and 0 minutes turns backups off', () => {
    expect(backupConfig({ BACKUP_INTERVAL_MINUTES: '0', BACKUP_KEEP: ' 3 ' })).toEqual({
      intervalMinutes: 0,
      keep: 3,
    });
  });

  it.each([
    ['BACKUP_INTERVAL_MINUTES', '6h'],
    ['BACKUP_INTERVAL_MINUTES', '-1'],
    ['BACKUP_INTERVAL_MINUTES', '1.5'],
    ['BACKUP_KEEP', '0'],
  ])('refuses %s=%s, naming it', (name, value) => {
    expect(() => backupConfig({ [name]: value })).toThrow(name);
  });
});

describe('takeBackup', () => {
  it('writes a self-contained copy named by UTC time that opens with the same rows', () => {
    const db = seeded();
    const result = takeBackup(db, backups, 8, at('2026-10-13T10:15:00.123Z'));

    expect(result.path).toBe(join(backups, 'sente-20261013T101500Z.db'));
    expect(result.bytes).toBeGreaterThan(0);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.pruned).toEqual([]);
    const copy = dbs.open(result.path);
    expect(copy.prepare('SELECT agent_id FROM agent_watchers').all()).toEqual([{ agent_id: 'a' }]);
  });

  it('keeps the newest N and deletes only backups, never other files', () => {
    const db = seeded();
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'notes.txt'), 'mine');
    writeFileSync(join(backups, 'sente-before-cutover.db'), 'mine too');
    for (const hour of ['00', '06', '12']) {
      takeBackup(db, backups, 2, at(`2026-10-13T${hour}:00:00Z`));
    }

    expect(readdirSync(backups).sort()).toEqual([
      'notes.txt',
      'sente-20261013T060000Z.db',
      'sente-20261013T120000Z.db',
      'sente-before-cutover.db',
    ]);
  });

  it('fails rather than overwrite a backup of the same second', () => {
    const db = seeded();
    takeBackup(db, backups, 8, at('2026-10-13T00:00:00Z'));
    expect(() => takeBackup(db, backups, 8, at('2026-10-13T00:00:00.500Z'))).toThrow();
  });
});

describe('pruneBackups', () => {
  it('is a no-op under the limit', () => {
    mkdirSync(backups);
    writeFileSync(join(backups, backupFileName(at('2026-10-13T00:00:00Z'))), '');
    expect(pruneBackups(backups, 8)).toEqual([]);
  });
});

describe('SenteDbBackups', () => {
  const lease = (db: SenteDb | undefined): SenteDbLease =>
    ({ dir, db, backend: db ? 'sqlite' : 'file' }) as unknown as SenteDbLease;

  it('takes one backup right after boot, without holding the boot up', async () => {
    const service = new SenteDbBackups(lease(seeded()));
    service.onApplicationBootstrap();
    expect(readdirSync(dir)).not.toContain('backups');

    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync(backups)).toHaveLength(1);
    service.onModuleDestroy();
  });

  it('logs a failed backup instead of throwing', () => {
    const db = seeded();
    const service = new SenteDbBackups(lease(db));
    db.close();
    expect(() => service.backup()).not.toThrow();
  });

  it('does nothing under the file backend', async () => {
    const service = new SenteDbBackups(lease(undefined));
    service.onApplicationBootstrap();
    service.backup();
    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync(dir)).toEqual([]);
  });
});
