import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openedDbs } from '../state/db/testing/opened-dbs';
import { FileProfileStore, type ProfileStore } from './profile.store';
import { SqliteProfileStore } from './sqlite-profile.store';

const ALICE = '0x' + 'a'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);
const NOW = new Date('2026-10-13T12:00:00Z');

let dir: string;
let path: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-profiles-'));
  path = join(dir, 'profiles.json');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** A SQLite store on `<dir>/sente.db`; calling it again is a restart. */
const sqliteStore = (): SqliteProfileStore => new SqliteProfileStore(dbs.reopen(dir));

/** Every implementation `STATE_DIR` and `STORE_BACKEND` can pick, through one table (SEN-205). */
describe.each([
  ['in memory', (): ProfileStore => new FileProfileStore()],
  ['FileProfileStore', (): ProfileStore => new FileProfileStore(path)],
  ['SqliteProfileStore', (): ProfileStore => sqliteStore()],
])('%s', (_name, create) => {
  it('answers the defaults for a user who never changed anything', () => {
    expect(create().get(ALICE)).toEqual({ name: null, avatarSeed: null });
  });

  it('applies the fields present, keeps the ones left out, and resets with null', () => {
    const store = create();
    expect(store.set(ALICE, { name: 'Based Whale' }, NOW)).toEqual({
      name: 'Based Whale',
      avatarSeed: null,
    });
    expect(store.set(ALICE, { avatarSeed: '3' }, NOW)).toEqual({
      name: 'Based Whale',
      avatarSeed: '3',
    });
    expect(store.set(ALICE, { name: null }, NOW)).toEqual({ name: null, avatarSeed: '3' });
    expect(store.get(ALICE)).toEqual({ name: null, avatarSeed: '3' });
    expect(store.get(BOB)).toEqual({ name: null, avatarSeed: null });
  });
});

describe.each([
  ['FileProfileStore', () => new FileProfileStore(path)],
  ['SqliteProfileStore', () => sqliteStore()],
])('%s across a restart', (_name, open) => {
  it('keeps each user’s overrides', () => {
    open().set(ALICE, { name: 'Diamond Gecko', avatarSeed: 'r7' }, NOW);
    expect(open().get(ALICE)).toEqual({ name: 'Diamond Gecko', avatarSeed: 'r7' });
  });

  it('keeps no record for a user back at both defaults', () => {
    const store = open();
    store.set(ALICE, { name: 'Lucky Crab' }, NOW);
    store.set(BOB, { avatarSeed: '1' }, NOW);
    store.set(ALICE, { name: null }, NOW);
    const restarted = open();
    expect(restarted.size).toBe(1);
    expect(restarted.get(ALICE)).toEqual({ name: null, avatarSeed: null });
    expect(restarted.get(BOB)).toEqual({ name: null, avatarSeed: '1' });
  });
});
