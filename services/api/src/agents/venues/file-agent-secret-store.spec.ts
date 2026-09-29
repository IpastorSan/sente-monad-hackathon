import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { InMemoryAgentSecretStore } from './agent-secret-store';
import { agentSecretStore } from './agent-venues.providers';
import { FileAgentSecretStore, agentSecretsKey } from './file-agent-secret-store';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const API_KEY = 'perpl-api-key-FAKE-do-not-leak';
const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SECRET_B64 = Buffer.from(secret()).toString('base64');

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-secrets-'));
  path = join(dir, 'agent-secrets.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FileAgentSecretStore (SEN-148)', () => {
  it('seals and unseals: what was stored comes back, and nothing for an unknown agent', async () => {
    const store = new FileAgentSecretStore(path, KEY);
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });

    const held = await store.getPerplCredentials('a1');
    expect(held?.apiKey).toBe(API_KEY);
    expect(Array.from(held!.secretKey)).toEqual(Array.from(secret()));
    await expect(store.getPerplCredentials('a2')).resolves.toBeUndefined();
  });

  it('keeps the credentials across a restart', async () => {
    await new FileAgentSecretStore(path, KEY).putPerplCredentials('a1', {
      apiKey: API_KEY,
      secretKey: secret(),
    });

    const restarted = new FileAgentSecretStore(path, KEY);
    expect(restarted.size).toBe(1);
    const held = await restarted.getPerplCredentials('a1');
    expect(held?.apiKey).toBe(API_KEY);
    expect(Array.from(held!.secretKey)).toEqual(Array.from(secret()));
  });

  it('writes neither the API key nor the secret in the clear', async () => {
    await new FileAgentSecretStore(path, KEY).putPerplCredentials('a1', {
      apiKey: API_KEY,
      secretKey: secret(),
    });
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET_B64);
    expect(text).not.toContain(Buffer.from(secret()).toString('hex'));
  });

  it('refuses to start with a wrong key instead of starting empty', async () => {
    await new FileAgentSecretStore(path, KEY).putPerplCredentials('a1', {
      apiKey: API_KEY,
      secretKey: secret(),
    });
    expect(() => new FileAgentSecretStore(path, OTHER_KEY)).toThrow(/cannot decrypt.*a1/);
  });

  it('refuses a record moved onto another agent (the agent id is bound in)', async () => {
    await new FileAgentSecretStore(path, KEY).putPerplCredentials('a1', {
      apiKey: API_KEY,
      secretKey: secret(),
    });
    writeFileSync(path, readFileSync(path, 'utf8').replace('"a1"', '"a2"'));
    expect(() => new FileAgentSecretStore(path, KEY)).toThrow(/cannot decrypt.*a2/);
  });

  it('forgets an agent on delete, across a restart too', async () => {
    const store = new FileAgentSecretStore(path, KEY);
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    await store.putPerplCredentials('a2', { apiKey: 'other', secretKey: secret() });
    await store.deleteAgent('a1');

    await expect(store.getPerplCredentials('a1')).resolves.toBeUndefined();
    const restarted = new FileAgentSecretStore(path, KEY);
    await expect(restarted.getPerplCredentials('a1')).resolves.toBeUndefined();
    expect((await restarted.getPerplCredentials('a2'))?.apiKey).toBe('other');
  });

  it('keeps its own copy: the caller zeroing theirs changes nothing', async () => {
    const store = new FileAgentSecretStore(path, KEY);
    const original = { apiKey: API_KEY, secretKey: secret() };
    await store.putPerplCredentials('a1', original);
    original.secretKey.fill(0);
    (await store.getPerplCredentials('a1'))!.secretKey.fill(0);

    expect(Array.from((await store.getPerplCredentials('a1'))!.secretKey)).toEqual(
      Array.from(secret()),
    );
  });

  it('hands out credentials that print nothing secret', async () => {
    const store = new FileAgentSecretStore(path, KEY);
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
  it('stays in memory without STATE_DIR', () => {
    expect(agentSecretStore({})).toBeInstanceOf(InMemoryAgentSecretStore);
  });

  it('is file-backed and encrypted with STATE_DIR, and needs the key', () => {
    expect(() => agentSecretStore({ STATE_DIR: dir })).toThrow(/AGENT_SECRETS_KEY is required/);
    const store = agentSecretStore({ STATE_DIR: dir, AGENT_SECRETS_KEY: KEY.toString('hex') });
    expect(store).toBeInstanceOf(FileAgentSecretStore);
    expect((store as FileAgentSecretStore).path).toBe(path);
  });
});
