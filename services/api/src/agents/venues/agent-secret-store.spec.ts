import { inspect } from 'node:util';

import { InMemoryAgentSecretStore, sealPerplCredentials } from './agent-secret-store';

const API_KEY = 'perpl-api-key-FAKE-do-not-leak';
const secret = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe('InMemoryAgentSecretStore', () => {
  it('returns what was stored, and nothing for an unknown agent', async () => {
    const store = new InMemoryAgentSecretStore();
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });

    const held = await store.getPerplCredentials('a1');
    expect(held?.apiKey).toBe(API_KEY);
    expect(Array.from(held!.secretKey)).toEqual(Array.from(secret()));
    await expect(store.getPerplCredentials('a2')).resolves.toBeUndefined();
  });

  it('keeps its own copy: the caller zeroing theirs changes nothing', async () => {
    const store = new InMemoryAgentSecretStore();
    const original = { apiKey: API_KEY, secretKey: secret() };
    await store.putPerplCredentials('a1', original);
    original.secretKey.fill(0);
    (await store.getPerplCredentials('a1'))!.secretKey.fill(0);

    expect(Array.from((await store.getPerplCredentials('a1'))!.secretKey)).toEqual(
      Array.from(secret()),
    );
  });

  it('forgets an agent on delete', async () => {
    const store = new InMemoryAgentSecretStore();
    await store.putPerplCredentials('a1', { apiKey: API_KEY, secretKey: secret() });
    await store.deleteAgent('a1');
    await expect(store.getPerplCredentials('a1')).resolves.toBeUndefined();
  });
});

describe('sealPerplCredentials', () => {
  it('prints nothing secret through JSON, inspect, keys or spread', () => {
    const sealed = sealPerplCredentials({ apiKey: API_KEY, secretKey: secret() });
    const outputs = [
      JSON.stringify(sealed),
      JSON.stringify({ context: sealed }),
      inspect(sealed),
      inspect({ nested: { sealed } }, { depth: 5 }),
      `${Object.keys(sealed).join(',')}`,
      JSON.stringify({ ...sealed }),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(API_KEY);
      expect(output).not.toMatch(/1,\s*2,\s*3/);
    }
    expect(sealed.apiKey).toBe(API_KEY);
  });
});
