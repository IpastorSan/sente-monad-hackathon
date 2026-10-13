import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { creditKeyStore } from '../credits.module';
import { CreditsService, createOpenRouterKeys } from '../credits.service';
import type { CreditsConfig } from '../credits.config';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from '../testing/fake-openrouter';
import { InMemoryCreditKeyStore } from './credit-key-store';
import { FileCreditKeyStore } from './file-credit-key-store';

const SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 9);
const OR_KEY = 'sk-or-v1-user-key-FAKE-do-not-leak';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-credit-keys-'));
  path = join(dir, 'credit-keys.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FileCreditKeyStore (SEN-204)', () => {
  it('keeps a binding across a restart and still refuses a second claim', async () => {
    await new FileCreditKeyStore(path, SECRET).claim({ userId: 'u1', hash: 'h1', key: OR_KEY });

    const restarted = new FileCreditKeyStore(path, SECRET);
    expect(restarted.size).toBe(1);
    const found = await restarted.find('u1');
    expect(found).toMatchObject({ userId: 'u1', hash: 'h1', key: OR_KEY });
    expect(found?.createdAt).toBeInstanceOf(Date);

    const second = await restarted.claim({ userId: 'u1', hash: 'h2', key: 'other' });
    expect(second).toMatchObject({ ok: false, existing: { hash: 'h1' } });
    await expect(restarted.find('nobody')).resolves.toBeUndefined();
  });

  it('never writes the key in the clear', async () => {
    await new FileCreditKeyStore(path, SECRET).claim({ userId: 'u1', hash: 'h1', key: OR_KEY });
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(OR_KEY);
    expect(text).toContain('h1');
  });

  it('refuses to boot under a different secret rather than start empty', async () => {
    await new FileCreditKeyStore(path, SECRET).claim({ userId: 'u1', hash: 'h1', key: OR_KEY });
    expect(() => new FileCreditKeyStore(path, OTHER_SECRET)).toThrow(/cannot decrypt user u1/);
  });

  it('is what the module binds with STATE_DIR set, and in memory without it', () => {
    expect(creditKeyStore({})).toBeInstanceOf(InMemoryCreditKeyStore);
    expect(
      creditKeyStore({ STATE_DIR: dir, AGENT_SECRETS_KEY: SECRET.toString('hex') }),
    ).toBeInstanceOf(FileCreditKeyStore);
    expect(() => creditKeyStore({ STATE_DIR: dir })).toThrow(/AGENT_SECRETS_KEY/);
  });

  it('a restarted API does not mint the same user a second key', async () => {
    const config: CreditsConfig = {
      managementKey: FAKE_MANAGEMENT_KEY,
      sharedKey: undefined,
      mode: 'per-user',
      defaultLimitUsd: 5,
    };
    const fake = fakeOpenRouter();
    const boot = () =>
      new CreditsService(
        config,
        createOpenRouterKeys(config, fake.fetch),
        new FileCreditKeyStore(path, SECRET),
      );

    expect((await boot().provision({ userId: 'u1' })).created).toBe(true);
    const restarted = boot();
    expect((await restarted.provision({ userId: 'u1' })).created).toBe(false);
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(fake.keys.size).toBe(1);
    await expect(restarted.keyFor('u1')).resolves.toMatch(/^sk-or-/);
  });
});
