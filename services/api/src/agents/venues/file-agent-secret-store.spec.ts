import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { openedDbs } from '../../state/db/testing/opened-dbs';
import { InMemoryAgentSecretStore, type AgentSecretStore } from './agent-secret-store';
import { agentSecretStore } from './agent-venues.providers';
import { FileAgentSecretStore, agentSecretsKey } from './file-agent-secret-store';
import { SqliteAgentSecretStore } from './sqlite-agent-secret-store';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const API_KEY = 'perpl-api-key-FAKE-do-not-leak';
const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SECRET_B64 = Buffer.from(secret()).toString('base64');

let dir: string;
let path: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-secrets-'));
  path = join(dir, 'agent-secrets.json');
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Both persistent stores (SEN-148, SEN-205), each with what it holds at rest
 * as text and a way to move a1's sealed record onto a2. Opening one again is
 * a restart.
 */
const persistent = [
  {
    name: 'FileAgentSecretStore',
    open: (key: Uint8Array = KEY): AgentSecretStore & { size: number } =>
      new FileAgentSecretStore(path, key),
    atRest: (): string => readFileSync(path, 'utf8'),
    moveA1ToA2: (): void => writeFileSync(path, readFileSync(path, 'utf8').replace('"a1"', '"a2"')),
  },
  {
    name: 'SqliteAgentSecretStore',
    open: (key: Uint8Array = KEY): AgentSecretStore & { size: number } =>
      new SqliteAgentSecretStore(dbs.reopen(dir), key),
    atRest: (): string => JSON.stringify(dbs.last!.prepare('SELECT * FROM agent_secrets').all()),
    moveA1ToA2: (): void => {
      const db = dbs.reopen(dir);
      db.exec(
        `UPDATE agent_secrets SET agent_id = 'a2', data = replace(data, '"a1"', '"a2"') WHERE agent_id = 'a1'`,
      );
      dbs.closeAll();
    },
  },
];

describe.each(persistent)('$name (SEN-148)', ({ open, atRest, moveA1ToA2 }) => {
  it('seals and unseals: what was stored comes back, and nothing for an unknown agent', async () => {
    const store = open();
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });

    const held = await store.getPerplCredentials('a1');
    expect(held?.apiKey).toBe(API_KEY);
    expect(Array.from(held!.secretKey)).toEqual(Array.from(secret()));
    await expect(store.getPerplCredentials('a2')).resolves.toBeUndefined();
  });

  it('keeps the credentials across a restart', async () => {
    await open().putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });

    const restarted = open();
    expect(restarted.size).toBe(1);
    const held = await restarted.getPerplCredentials('a1');
    expect(held?.apiKey).toBe(API_KEY);
    expect(Array.from(held!.secretKey)).toEqual(Array.from(secret()));
  });

  it('writes neither the API key nor the secret in the clear', async () => {
    await open().putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    const text = atRest();
    expect(text).toContain('a1');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET_B64);
    expect(text).not.toContain(Buffer.from(secret()).toString('hex'));
  });

  it('refuses to start with a wrong key instead of starting empty', async () => {
    await open().putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    expect(() => open(OTHER_KEY)).toThrow(/cannot decrypt.*a1/);
  });

  it('refuses a record moved onto another agent (the agent id is bound in)', async () => {
    await open().putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    moveA1ToA2();
    expect(() => open()).toThrow(/cannot decrypt.*a2/);
  });

  it('forgets an agent on delete, across a restart too', async () => {
    const store = open();
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    await store.putPerplCredentials('a2', { apiKey: 'other', secretKey: secret() });
    await store.deleteAgent('a1');

    await expect(store.getPerplCredentials('a1')).resolves.toBeUndefined();
    const restarted = open();
    await expect(restarted.getPerplCredentials('a1')).resolves.toBeUndefined();
    expect((await restarted.getPerplCredentials('a2'))?.apiKey).toBe('other');
  });

  it('keeps its own copy: the caller zeroing theirs changes nothing', async () => {
    const store = open();
    const original = { apiKey: API_KEY, secretKey: secret() };
    await store.putPerplCredentials('a1', original);
    original.secretKey.fill(0);
    (await store.getPerplCredentials('a1'))!.secretKey.fill(0);

    expect(Array.from((await store.getPerplCredentials('a1'))!.secretKey)).toEqual(
      Array.from(secret()),
    );
  });

  it('hands out credentials that print nothing secret', async () => {
    const store = open();
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    const held = await store.getPerplCredentials('a1');
    for (const output of [JSON.stringify({ held }), inspect({ held }, { depth: 5 })]) {
      expect(output).not.toContain(API_KEY);
      expect(output).not.toMatch(/1,\s*2,\s*3/);
    }
  });
});

describe('agentSecretsKey', () => {
  it('reads 64 hex characters', () => {
    expect(agentSecretsKey({ AGENT_SECRETS_KEY: KEY.toString('hex') })).toEqual(KEY);
  });

  it('refuses a missing or malformed key', () => {
    expect(() => agentSecretsKey({})).toThrow(/AGENT_SECRETS_KEY is required/);
    expect(() => agentSecretsKey({ AGENT_SECRETS_KEY: 'abc' })).toThrow(/64 hex/);
  });
});

describe('agentSecretStore (the provider)', () => {
  const env = { AGENT_SECRETS_KEY: KEY.toString('hex') };

  it('stays in memory without STATE_DIR', () => {
    expect(agentSecretStore({ dir: undefined, db: undefined }, {})).toBeInstanceOf(
      InMemoryAgentSecretStore,
    );
  });

  it('is file-backed and encrypted with STATE_DIR, and needs the key', () => {
    expect(() => agentSecretStore({ dir, db: undefined }, {})).toThrow(
      /AGENT_SECRETS_KEY is required/,
    );
    const store = agentSecretStore({ dir, db: undefined }, env);
    expect(store).toBeInstanceOf(FileAgentSecretStore);
    expect((store as FileAgentSecretStore).path).toBe(path);
  });

  it('is a sealed table under STORE_BACKEND=sqlite, and still needs the key', () => {
    const db = dbs.reopen(dir);
    expect(() => agentSecretStore({ dir, db }, {})).toThrow(/AGENT_SECRETS_KEY is required/);
    expect(agentSecretStore({ dir, db }, env)).toBeInstanceOf(SqliteAgentSecretStore);
  });
});
