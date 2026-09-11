import { OpenRouterApiError, OpenRouterManagementClient } from './openrouter.client';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from './testing/fake-openrouter';

function client(fetch = fakeOpenRouter().fetch, managementKey = FAKE_MANAGEMENT_KEY) {
  return new OpenRouterManagementClient({ managementKey, fetch });
}

describe('OpenRouterManagementClient', () => {
  it('creates a key with the management key as a bearer token and returns the plaintext once', async () => {
    const fake = fakeOpenRouter();
    const created = await client(fake.fetch).createKey({
      name: 'sente:user-1',
      limit: 5,
      limit_reset: 'monthly',
      include_byok_in_limit: true,
      external: { user: 'user-1' },
    });

    expect(created.key).toBe('sk-or-v1-PLAINTEXT-1');
    expect(created.data).toMatchObject({ hash: 'hash1', limit: 5, limit_reset: 'monthly' });
    expect(fake.calls).toEqual([
      {
        method: 'POST',
        url: 'https://openrouter.ai/api/v1/keys',
        authorization: `Bearer ${FAKE_MANAGEMENT_KEY}`,
        body: {
          name: 'sente:user-1',
          limit: 5,
          limit_reset: 'monthly',
          include_byok_in_limit: true,
          external: { user: 'user-1' },
        },
      },
    ]);
  });

  it('reads, updates and deletes a key by hash', async () => {
    const fake = fakeOpenRouter();
    const api = client(fake.fetch);
    const { data } = await api.createKey({ name: 'k', limit: 1 });

    expect((await api.getKey(data.hash)).usage_monthly).toBe(0);
    expect(await api.updateKey(data.hash, { limit: 2, disabled: true })).toMatchObject({
      limit: 2,
      disabled: true,
    });
    await api.deleteKey(data.hash);

    expect(fake.keys.size).toBe(0);
    expect(fake.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/v1/keys',
      'GET /api/v1/keys/hash1',
      'PATCH /api/v1/keys/hash1',
      'DELETE /api/v1/keys/hash1',
    ]);
  });

  it('surfaces upstream errors with status and message, never the management key', async () => {
    const error = await client(fakeOpenRouter().fetch, 'sk-or-v1-WRONG-management')
      .getKey('hash1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenRouterApiError);
    expect((error as OpenRouterApiError).status).toBe(401);
    expect((error as Error).message).toBe('GET /keys/:hash: HTTP 401 Invalid credentials');
    expect((error as Error).message).not.toContain('WRONG');
  });

  it('reports a network failure as status 0', async () => {
    const api = client(() => Promise.reject(new Error('ECONNRESET')));

    await expect(api.deleteKey('hash1')).rejects.toMatchObject({
      status: 0,
      message: 'DELETE /keys/:hash: ECONNRESET',
    });
  });

  it('refuses a malformed hash without calling out', async () => {
    const fake = fakeOpenRouter();

    await expect(client(fake.fetch).getKey('../credits')).rejects.toThrow(/malformed key hash/);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a create response that carries no plaintext key, without echoing it', async () => {
    const api = client(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { hash: 'h' } }), { status: 201 })),
    );

    await expect(api.createKey({ name: 'k', limit: 1 })).rejects.toThrow(
      'POST /keys: response has no key or key data',
    );
  });
});
