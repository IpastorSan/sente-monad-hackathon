import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openedDbs } from '../../state/db/testing/opened-dbs';
import { SqliteWatcherStore } from './sqlite-watcher-store';
import { testWatcherSet } from './testing/watcher-set';
import { FileWatcherStore, InMemoryWatcherStore, type WatcherStore } from './watcher-store';

let dir: string;
let path: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-watchers-'));
  path = join(dir, 'agent-watchers.json');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** A SQLite store on `<dir>/sente.db`; "a restart" is closing it and calling this again. */
const sqliteStore = (): SqliteWatcherStore => new SqliteWatcherStore(dbs.reopen(dir));

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** One table, every implementation (SEN-205): only `STORE_BACKEND` picks between them. */
describe.each([
  ['InMemoryWatcherStore', (): WatcherStore => new InMemoryWatcherStore()],
  ['FileWatcherStore', (): WatcherStore => new FileWatcherStore(path)],
  ['SqliteWatcherStore', (): WatcherStore => sqliteStore()],
])('%s', (_name, create) => {
  it('stores a set and reads it back exactly, edge state included', () => {
    const store = create();
    const set = testWatcherSet(AGENT);
    store.put(set);

    expect(store.get(AGENT)).toEqual(set);
    expect(store.peek(AGENT)).toEqual(set);
    expect(store.get(AGENT)!.watchers[0]!.edges).toEqual([false, null]);
    expect(store.get(OTHER)).toBeUndefined();
    expect(store.peek(OTHER)).toBeUndefined();
  });

  it('replaces a set whole, and keeps sets of different agents apart', () => {
    const store = create();
    store.put(testWatcherSet(AGENT));
    store.put(testWatcherSet(OTHER, { checks: 1 }));
    store.put(testWatcherSet(AGENT, { checks: 9, watchers: [] }));

    expect(store.get(AGENT)).toMatchObject({ checks: 9, watchers: [] });
    expect(store.get(OTHER)).toMatchObject({ checks: 1 });
  });

  it('hands out copies: changing one changes nothing stored', () => {
    const store = create();
    const set = testWatcherSet(AGENT);
    store.put(set);
    (set as { checks: number }).checks = 100;
    const read = store.get(AGENT)!;
    (read as { checks: number }).checks = 200;

    expect(store.get(AGENT)!.checks).toBe(5);
  });

  it('deletes, and deleting nothing is not an error', () => {
    const store = create();
    store.put(testWatcherSet(AGENT));
    store.delete(AGENT);
    store.delete(AGENT);

    expect(store.get(AGENT)).toBeUndefined();
  });
});

describe.each([
  ['FileWatcherStore', () => new FileWatcherStore(path)],
  ['SqliteWatcherStore', () => sqliteStore()],
])('%s across a restart', (_name, open) => {
  it('keeps every set, its edges and its counters', () => {
    const first = open();
    const set = testWatcherSet(AGENT);
    first.put(set);
    first.put(testWatcherSet(OTHER));
    first.delete(OTHER);

    const reopened = open();
    expect(reopened.size).toBe(1);
    expect(reopened.get(AGENT)).toEqual(set);
    expect(reopened.get(OTHER)).toBeUndefined();
  });
});

describe('SqliteWatcherStore', () => {
  it('lists every set in the order first stored, for the import', async () => {
    const store = sqliteStore();
    store.put(testWatcherSet(OTHER));
    store.put(testWatcherSet(AGENT));
    store.put(testWatcherSet(OTHER, { checks: 7 }));

    expect((await store.listAll()).map((set) => [set.agentId, set.checks])).toEqual([
      [OTHER, 7],
      [AGENT, 5],
    ]);
  });
});
