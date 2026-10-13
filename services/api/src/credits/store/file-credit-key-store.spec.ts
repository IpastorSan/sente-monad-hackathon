import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openedDbs } from '../../state/db/testing/opened-dbs';
import { creditKeyStore } from '../credits.module';
import { CreditsService, createOpenRouterKeys } from '../credits.service';
import type { CreditsConfig } from '../credits.config';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from '../testing/fake-openrouter';
import { InMemoryCreditKeyStore, type CreditKeyStore } from './credit-key-store';
import { FileCreditKeyStore } from './file-credit-key-store';
import { SqliteCreditKeyStore } from './sqlite-credit-key-store';

const SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 9);
const OR_KEY = 'sk-or-v1-user-key-FAKE-do-not-leak';

let dir: string;
let path: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-credit-keys-'));
  path = join(dir, 'credit-keys.json');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** Both persistent stores (SEN-204, SEN-205); opening one again is a restart. */
describe.each([
  {
    name: 'FileCreditKeyStore',
    open: (secret: Uint8Array = SECRET): CreditKeyStore & { size: number } =>
      new FileCreditKeyStore(path, secret),
    atRest: (): string => readFileSync(path, 'utf8'),
  },
  {
    name: 'SqliteCreditKeyStore',
    open: (secret: Uint8Array = SECRET): CreditKeyStore & { size: number } =>
      new SqliteCreditKeyStore(dbs.reopen(dir), secret),
    atRest: (): string => JSON.stringify(dbs.last!.prepare('SELECT * FROM credit_keys').all()),
  },
])('$name (SEN-204)', ({ open, atRest }) => {
  it('keeps a binding across a restart and still refuses a second claim', async () => {
    await open().claim({ userId: 'u1', hash: 'h1', key: OR_KEY });

    const restarted = open();
    expect(restarted.size).toBe(1);
    const found = await restarted.find('u1');
    expect(found).toMatchObject({ userId: 'u1', hash: 'h1', key: OR_KEY });
    expect(found?.createdAt).toBeInstanceOf(Date);

    const second = await restarted.claim({ userId: 'u1', hash: 'h2', key: 'other' });
    expect(second).toMatchObject({ ok: false, existing: { hash: 'h1', key: OR_KEY } });
    await expect(restarted.find('nobody')).resolves.toBeUndefined();
  });

  it('never writes the key in the clear', async () => {
    await open().claim({ userId: 'u1', hash: 'h1', key: OR_KEY });
    const text = atRest();
    expect(text).not.toContain(OR_KEY);
    expect(text).toContain('h1');
  });

  it('refuses to boot under a different secret rather than start empty', async () => {
    await open().claim({ userId: 'u1', hash: 'h1', key: OR_KEY });
    expect(() => open(OTHER_SECRET)).toThrow(/cannot decrypt user u1/);
  });

  it('a restarted API does not mint the same user a second key', async () => {
    const config: CreditsConfig = {
      managementKey: FAKE_MANAGEMENT_KEY,
      sharedKey: undefined,
      mode: 'per-user',
      defaultLimitUsd: 5,
    };
    const fake = fakeOpenRouter();
    const boot = () => new CreditsService(config, createOpenRouterKeys(config, fake.fetch), open());

    expect((await boot().provision({ userId: 'u1' })).created).toBe(true);
    const restarted = boot();
    expect((await restarted.provision({ userId: 'u1' })).created).toBe(false);
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(fake.keys.size).toBe(1);
    await expect(restarted.keyFor('u1')).resolves.toMatch(/^sk-or-/);
  });
});

describe('creditKeyStore (the provider)', () => {
  const env = { AGENT_SECRETS_KEY: SECRET.toString('hex') };

  it('is in memory without STATE_DIR, the file with it, and needs the key', () => {
    expect(creditKeyStore({ dir: undefined, db: undefined }, {})).toBeInstanceOf(
      InMemoryCreditKeyStore,
    );
    expect(creditKeyStore({ dir, db: undefined }, env)).toBeInstanceOf(FileCreditKeyStore);
    expect(() => creditKeyStore({ dir, db: undefined }, {})).toThrow(/AGENT_SECRETS_KEY/);
  });

  it('is a sealed table under STORE_BACKEND=sqlite, and still needs the key', () => {
    const db = dbs.reopen(dir);
    expect(creditKeyStore({ dir, db }, env)).toBeInstanceOf(SqliteCreditKeyStore);
    expect(() => creditKeyStore({ dir, db }, {})).toThrow(/AGENT_SECRETS_KEY/);
  });
});
