import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storeBackend } from '../store-backend';
import { MIGRATIONS, type Migration } from './migrations';
import { IN_MEMORY, SenteDb, senteDbPath } from './sente-db';

let dir: string;
const open: SenteDb[] = [];

/** Every database a test opens is closed after it, whether it passed or not. */
function opened(db: SenteDb): SenteDb {
  open.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-db-'));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tables = (db: SenteDb): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row['name']));

describe('migrations', () => {
  it('apply every migration to a fresh in-memory database, in order', () => {
    const db = opened(SenteDb.open(IN_MEMORY));

    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_m, i) => i + 1));
    expect(
      db
        .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
        .all()
        .map((row) => [Number(row['id']), String(row['name'])]),
    ).toEqual(MIGRATIONS.map((m) => [m.id, m.name]));
    expect(tables(db)).toEqual(expect.arrayContaining(['agents', 'user_wallets']));
  });

  it('are idempotent: reopening the same file applies nothing', () => {
    const path = senteDbPath(dir);
    const first = opened(SenteDb.open(path));
    expect(first.migrate()).toEqual([]);
    first.close();

    const second = opened(SenteDb.open(path));
    expect(second.schemaVersion).toBe(MIGRATIONS.length);
    expect(second.migrate()).toEqual([]);
  });

  it('refuse a migration that was edited after it ran', () => {
    const path = senteDbPath(dir);
    opened(SenteDb.open(path)).close();

    const edited: Migration[] = [{ ...MIGRATIONS[0]!, name: 'something-else' }];
    expect(() => SenteDb.open(path, edited)).toThrow(/recorded as "agents-and-user-wallets"/);
  });

  it('refuse a database written by a newer build', () => {
    const path = senteDbPath(dir);
    const newer: Migration[] = [
      ...MIGRATIONS,
      { id: MIGRATIONS.length + 1, name: 'future', sql: 'CREATE TABLE future (x TEXT)' },
    ];
    opened(SenteDb.open(path, newer)).close();

    expect(() => SenteDb.open(path, MIGRATIONS)).toThrow(/newer build/);
  });

  it('refuse a registry with a gap or a wrong order', () => {
    const gap: Migration[] = [MIGRATIONS[0]!, { id: 3, name: 'skips-two', sql: 'SELECT 1' }];
    expect(() => SenteDb.open(IN_MEMORY, gap)).toThrow(/out of order/);
  });
});

describe('pragmas', () => {
  it('open a WAL database with foreign keys on and a busy timeout', () => {
    const db = opened(SenteDb.open(senteDbPath(dir)));

    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
  });

  it('creates STATE_DIR when it does not exist yet', () => {
    const db = opened(SenteDb.open(senteDbPath(join(dir, 'fresh', 'state'))));
    expect(existsSync(db.path)).toBe(true);
  });
});

describe('transaction', () => {
  const count = (db: SenteDb) => Number(db.prepare('SELECT count(*) AS n FROM t').get()!['n']);
  const withTable = () => {
    const db = opened(SenteDb.open(IN_MEMORY));
    db.exec('CREATE TABLE t (v TEXT)');
    return db;
  };

  it('commits what fn did and returns its result', () => {
    const db = withTable();
    const result = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run('a');
      expect(db.inTransaction).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(db.inTransaction).toBe(false);
    expect(count(db)).toBe(1);
  });

  it('rolls back everything when fn throws', () => {
    const db = withTable();
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run('a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count(db)).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('lets a nested call join the outer transaction: both land, or neither', () => {
    const db = withTable();
    const insert = (v: string) =>
      db.transaction(() => db.prepare('INSERT INTO t VALUES (?)').run(v));

    db.transaction(() => {
      insert('a');
      insert('b');
    });
    expect(count(db)).toBe(2);

    expect(() =>
      db.transaction(() => {
        insert('c');
        throw new Error('outer fails after the inner committed its savepoint');
      }),
    ).toThrow();
    expect(count(db)).toBe(2);
  });

  it('rolls back only the nested work when the outer catches the inner throw', () => {
    const db = withTable();
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run('kept');
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (?)').run('dropped');
          throw new Error('inner');
        });
      } catch {
        // the outer decides to go on
      }
    });
    expect(
      db
        .prepare('SELECT v FROM t')
        .all()
        .map((r) => r['v']),
    ).toEqual(['kept']);
  });

  it('refuses an async fn, rolling back', () => {
    const db = withTable();
    expect(() =>
      db.transaction(async () => {
        db.prepare('INSERT INTO t VALUES (?)').run('a');
      }),
    ).toThrow(/returned a Promise/);
    expect(count(db)).toBe(0);
  });
});

describe('backupTo', () => {
  it('writes a consistent copy that opens on its own', () => {
    const db = opened(SenteDb.open(senteDbPath(dir)));
    db.prepare(
      'INSERT INTO user_wallets (user_id, wallet_id, address, device_public_key, created_at, data) ' +
        "VALUES ('alice', 'w1', '0xabc', 'key', '2026-10-13T00:00:00.000Z', '{}')",
    ).run();

    const copy = join(dir, 'backups', 'sente-copy.db');
    db.backupTo(copy);

    const restored = opened(SenteDb.open(copy));
    expect(restored.schemaVersion).toBe(MIGRATIONS.length);
    expect(restored.prepare('SELECT user_id FROM user_wallets').all()).toEqual([
      { user_id: 'alice' },
    ]);
  });
});

describe('storeBackend', () => {
  it('defaults to file, reads sqlite, and refuses anything else by name', () => {
    expect(storeBackend({})).toBe('file');
    expect(storeBackend({ STORE_BACKEND: '' })).toBe('file');
    expect(storeBackend({ STORE_BACKEND: 'file' })).toBe('file');
    expect(storeBackend({ STORE_BACKEND: ' sqlite ' })).toBe('sqlite');
    expect(() => storeBackend({ STORE_BACKEND: 'postgres' })).toThrow(
      /STORE_BACKEND="postgres" is not a store backend/,
    );
  });
});
