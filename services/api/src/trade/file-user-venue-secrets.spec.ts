import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { openedDbs } from '../state/db/testing/opened-dbs';
import { FileUserVenueSecretStore } from './file-user-venue-secrets';
import { SqliteUserVenueSecretStore } from './sqlite-user-venue-secrets';
import { userVenueSecretStore } from './trade.module';
import { InMemoryUserVenueSecretStore, type UserVenueSecretStore } from './user-venue-secrets';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const READ_KEY = 'perpl-read-key-FAKE-do-not-leak';
const TRADE_TOKEN = 'perpl-trade-token-FAKE-do-not-leak';
const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SECRET_B64 = Buffer.from(secret()).toString('base64');

let dir: string;
let path: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-user-secrets-'));
  path = join(dir, 'user-venue-secrets.json');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

type Persistent = UserVenueSecretStore & { size: number };

/**
 * Both persistent stores (SEN-174, SEN-205), each with what it holds at rest
 * as text and a way to move u1's sealed record onto u2. Opening one again is
 * a restart.
 */
describe.each([
  {
    name: 'FileUserVenueSecretStore',
    open: (key: Uint8Array = KEY): Persistent => new FileUserVenueSecretStore(path, key),
    atRest: (): string => readFileSync(path, 'utf8'),
    moveU1ToU2: (): void => writeFileSync(path, readFileSync(path, 'utf8').replace('"u1"', '"u2"')),
  },
  {
    name: 'SqliteUserVenueSecretStore',
    open: (key: Uint8Array = KEY): Persistent =>
      new SqliteUserVenueSecretStore(dbs.reopen(dir), key),
    atRest: (): string =>
      JSON.stringify(dbs.last!.prepare('SELECT * FROM user_venue_secrets').all()),
    moveU1ToU2: (): void => {
      dbs
        .reopen(dir)
        .exec(
          `UPDATE user_venue_secrets SET user_id = 'u2', data = replace(data, '"u1"', '"u2"') WHERE user_id = 'u1'`,
        );
      dbs.closeAll();
    },
  },
])('$name (SEN-174)', ({ open, atRest, moveU1ToU2 }) => {
  async function enrolled(): Promise<Persistent> {
    const store = open();
    await store.putPerplRead('u1', { apiKey: READ_KEY, secretKey: secret() });
    await store.putPerplTradeToken('u1', TRADE_TOKEN);
    return store;
  }

  it('returns what was stored, and nothing for an unknown user', async () => {
    const store = await enrolled();
    const read = await store.getPerplRead('u1');
    expect(read?.apiKey).toBe(READ_KEY);
    expect(Array.from(read!.secretKey)).toEqual(Array.from(secret()));
    await expect(store.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
    await expect(store.getPerplRead('u2')).resolves.toBeUndefined();
    await expect(store.getPerplTradeToken('u2')).resolves.toBeUndefined();
  });

  it('keeps both keys across a restart', async () => {
    await enrolled();

    const restarted = open();
    expect(restarted.size).toBe(1);
    const read = await restarted.getPerplRead('u1');
    expect(read?.apiKey).toBe(READ_KEY);
    expect(Array.from(read!.secretKey)).toEqual(Array.from(secret()));
    await expect(restarted.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
  });

  it('keeps a token stored without a read key, and the other way round', async () => {
    const store = open();
    await store.putPerplTradeToken('u1', TRADE_TOKEN);
    await store.putPerplRead('u2', { apiKey: READ_KEY, secretKey: secret() });

    const restarted = open();
    await expect(restarted.getPerplRead('u1')).resolves.toBeUndefined();
    await expect(restarted.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
    await expect(restarted.getPerplTradeToken('u2')).resolves.toBeUndefined();
    expect((await restarted.getPerplRead('u2'))?.apiKey).toBe(READ_KEY);
  });

  it('writes no key in the clear', async () => {
    await enrolled();
    const text = atRest();
    expect(text).toContain('u1');
    expect(text).not.toContain(READ_KEY);
    expect(text).not.toContain(TRADE_TOKEN);
    expect(text).not.toContain(SECRET_B64);
    expect(text).not.toContain(Buffer.from(secret()).toString('hex'));
  });

  it('refuses to start with a wrong key instead of starting empty', async () => {
    await enrolled();
    expect(() => open(OTHER_KEY)).toThrow(/cannot decrypt.*u1/);
  });

  it('refuses a record moved onto another user (the user id is bound in)', async () => {
    await enrolled();
    moveU1ToU2();
    expect(() => open()).toThrow(/cannot decrypt.*u2/);
  });

  it('replaces a re-enrolled read key, keeping the token', async () => {
    const store = await enrolled();
    const before = await store.getPerplRead('u1');
    await store.putPerplRead('u1', { apiKey: 'second', secretKey: new Uint8Array(32).fill(3) });

    expect(Array.from(before!.secretKey)).toEqual(Array.from(secret())); // a copy, untouched
    const restarted = open();
    expect((await restarted.getPerplRead('u1'))?.apiKey).toBe('second');
    await expect(restarted.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
  });

  it('hands out sealed copies that print a placeholder', async () => {
    const store = await enrolled();
    const read = await store.getPerplRead('u1');
    expect(JSON.stringify(read)).not.toContain(READ_KEY);
    expect(inspect(read)).not.toContain(READ_KEY);
    read!.secretKey.fill(0);
    expect(Array.from((await store.getPerplRead('u1'))!.secretKey)).toEqual(Array.from(secret()));
  });
});

describe('FileUserVenueSecretStore', () => {
  it('rejects, and keeps memory in step with disk, when the write fails', async () => {
    // A file where the directory should be makes the save fail.
    writeFileSync(join(dir, 'blocker'), '');
    const blocked = new FileUserVenueSecretStore(join(dir, 'blocker', 'x.json'), KEY);
    await expect(blocked.putPerplTradeToken('u1', TRADE_TOKEN)).rejects.toThrow();
    await expect(blocked.getPerplTradeToken('u1')).resolves.toBeUndefined();
    expect(blocked.size).toBe(0);
  });
});

describe('userVenueSecretStore', () => {
  const env = { AGENT_SECRETS_KEY: KEY.toString('hex') };

  it('stays in memory without STATE_DIR', () => {
    expect(userVenueSecretStore({ dir: undefined, db: undefined }, {})).toBeInstanceOf(
      InMemoryUserVenueSecretStore,
    );
  });

  it('goes to disk under STATE_DIR and needs AGENT_SECRETS_KEY', () => {
    expect(() => userVenueSecretStore({ dir, db: undefined }, {})).toThrow(/AGENT_SECRETS_KEY/);
    const store = userVenueSecretStore({ dir, db: undefined }, env);
    expect(store).toBeInstanceOf(FileUserVenueSecretStore);
    expect((store as FileUserVenueSecretStore).path).toBe(path);
  });

  it('is a sealed table under STORE_BACKEND=sqlite, and still needs the key', () => {
    const db = dbs.reopen(dir);
    expect(() => userVenueSecretStore({ dir, db }, {})).toThrow(/AGENT_SECRETS_KEY/);
    expect(userVenueSecretStore({ dir, db }, env)).toBeInstanceOf(SqliteUserVenueSecretStore);
  });
});
