import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { FileUserVenueSecretStore } from './file-user-venue-secrets';
import { userVenueSecretStore } from './trade.module';
import { InMemoryUserVenueSecretStore } from './user-venue-secrets';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const READ_KEY = 'perpl-read-key-FAKE-do-not-leak';
const TRADE_TOKEN = 'perpl-trade-token-FAKE-do-not-leak';
const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SECRET_B64 = Buffer.from(secret()).toString('base64');

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-user-secrets-'));
  path = join(dir, 'user-venue-secrets.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function enrolled(): Promise<FileUserVenueSecretStore> {
  const store = new FileUserVenueSecretStore(path, KEY);
  await store.putPerplRead('u1', { apiKey: READ_KEY, secretKey: secret() });
  await store.putPerplTradeToken('u1', TRADE_TOKEN);
  return store;
}

describe('FileUserVenueSecretStore (SEN-174)', () => {
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

    const restarted = new FileUserVenueSecretStore(path, KEY);
    expect(restarted.size).toBe(1);
    const read = await restarted.getPerplRead('u1');
    expect(read?.apiKey).toBe(READ_KEY);
    expect(Array.from(read!.secretKey)).toEqual(Array.from(secret()));
    await expect(restarted.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
  });

  it('keeps a token stored without a read key, and the other way round', async () => {
    const store = new FileUserVenueSecretStore(path, KEY);
    await store.putPerplTradeToken('u1', TRADE_TOKEN);
    await store.putPerplRead('u2', { apiKey: READ_KEY, secretKey: secret() });

    const restarted = new FileUserVenueSecretStore(path, KEY);
    await expect(restarted.getPerplRead('u1')).resolves.toBeUndefined();
    await expect(restarted.getPerplTradeToken('u1')).resolves.toBe(TRADE_TOKEN);
    await expect(restarted.getPerplTradeToken('u2')).resolves.toBeUndefined();
    expect((await restarted.getPerplRead('u2'))?.apiKey).toBe(READ_KEY);
  });

  it('writes no key in the clear', async () => {
    await enrolled();
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(READ_KEY);
    expect(text).not.toContain(TRADE_TOKEN);
    expect(text).not.toContain(SECRET_B64);
    expect(text).not.toContain(Buffer.from(secret()).toString('hex'));
  });

  it('refuses to start with a wrong key instead of starting empty', async () => {
    await enrolled();
    expect(() => new FileUserVenueSecretStore(path, OTHER_KEY)).toThrow(/cannot decrypt.*u1/);
  });

  it('refuses a record moved onto another user (the user id is bound in)', async () => {
    await enrolled();
    writeFileSync(path, readFileSync(path, 'utf8').replace('"u1"', '"u2"'));
    expect(() => new FileUserVenueSecretStore(path, KEY)).toThrow(/cannot decrypt.*u2/);
  });

  it('replaces a re-enrolled read key and zeroes the old secret', async () => {
    const store = await enrolled();
    const before = await store.getPerplRead('u1');
    await store.putPerplRead('u1', { apiKey: 'second', secretKey: new Uint8Array(32).fill(3) });

    expect(Array.from(before!.secretKey)).toEqual(Array.from(secret())); // a copy, untouched
    const restarted = new FileUserVenueSecretStore(path, KEY);
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
  it('stays in memory without STATE_DIR', () => {
    expect(userVenueSecretStore({})).toBeInstanceOf(InMemoryUserVenueSecretStore);
  });

  it('goes to disk under STATE_DIR and needs AGENT_SECRETS_KEY', () => {
    expect(() => userVenueSecretStore({ STATE_DIR: dir })).toThrow(/AGENT_SECRETS_KEY/);
    const store = userVenueSecretStore({ STATE_DIR: dir, AGENT_SECRETS_KEY: KEY.toString('hex') });
    expect(store).toBeInstanceOf(FileUserVenueSecretStore);
    expect((store as FileUserVenueSecretStore).path).toBe(path);
  });
});
