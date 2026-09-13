import type { FetchLike, OpenRouterKey } from '../openrouter.client';

export const FAKE_MANAGEMENT_KEY = 'sk-or-v1-management-FAKE-do-not-leak';
/** An inference key, as used by shared-key dev mode (SEN-18). Only `GET /key` accepts it. */
export const FAKE_SHARED_KEY = 'sk-or-v1-shared-inference-FAKE-do-not-leak';

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/**
 * An in-memory stand-in for OpenRouter's `/api/v1/keys`, served through a fake
 * `fetch`. It mints recognisable plaintext keys (`sk-or-v1-PLAINTEXT-n`) so a
 * spec can assert they never reach an HTTP response.
 */
export function fakeOpenRouter(options: { failCreate?: number; failCurrentKey?: number } = {}) {
  const keys = new Map<string, OpenRouterKey>();
  const calls: RecordedCall[] = [];
  let minted = 0;
  let sharedUsage = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetch: FetchLike = (url, init) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, authorization: headers.Authorization, body });

    if (method === 'GET' && new URL(url).pathname === '/api/v1/key') {
      if (headers.Authorization !== `Bearer ${FAKE_SHARED_KEY}`) {
        return Promise.resolve(json(401, { error: { code: 401, message: 'Invalid API key' } }));
      }
      if (options.failCurrentKey) {
        return Promise.resolve(
          json(options.failCurrentKey, { error: { code: options.failCurrentKey, message: 'sad' } }),
        );
      }
      return Promise.resolve(
        json(200, {
          data: {
            label: 'sk-or-v1-sha...FAKE',
            limit: 10,
            limit_remaining: 10 - sharedUsage,
            usage: sharedUsage,
            is_free_tier: false,
          },
        }),
      );
    }

    if (headers.Authorization !== `Bearer ${FAKE_MANAGEMENT_KEY}`) {
      return Promise.resolve(json(401, { error: { code: 401, message: 'Invalid credentials' } }));
    }

    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    if (method === 'POST' && path === '/keys') {
      if (options.failCreate) {
        return Promise.resolve(
          json(options.failCreate, {
            error: { code: options.failCreate, message: 'upstream sad' },
          }),
        );
      }
      minted += 1;
      const input = body as {
        name: string;
        limit: number;
        limit_reset: OpenRouterKey['limit_reset'];
        include_byok_in_limit: boolean;
        external?: { user: string };
      };
      const data: OpenRouterKey = {
        hash: `hash${minted}`,
        name: input.name,
        label: `sk-or-v1-PLA...${minted}`,
        disabled: false,
        limit: input.limit,
        limit_remaining: input.limit,
        limit_reset: input.limit_reset,
        include_byok_in_limit: input.include_byok_in_limit,
        usage: 0,
        usage_daily: 0,
        usage_weekly: 0,
        usage_monthly: 0,
        created_at: '2026-09-11T00:00:00Z',
        updated_at: null,
        external_user: input.external?.user ?? null,
      };
      keys.set(data.hash, data);
      return Promise.resolve(json(201, { key: `sk-or-v1-PLAINTEXT-${minted}`, data }));
    }

    const hash = /^\/keys\/([^/]+)$/.exec(path)?.[1];
    const key = hash ? keys.get(hash) : undefined;
    if (!hash || !key) {
      return Promise.resolve(json(404, { error: { code: 404, message: 'Not found' } }));
    }
    if (method === 'GET') {
      return Promise.resolve(json(200, { data: key }));
    }
    if (method === 'PATCH') {
      Object.assign(key, body);
      return Promise.resolve(json(200, { data: key }));
    }
    if (method === 'DELETE') {
      keys.delete(hash);
      return Promise.resolve(json(200, { deleted: true }));
    }
    return Promise.resolve(json(405, { error: { code: 405, message: 'Method not allowed' } }));
  };

  /** Simulates inference spend against a key. */
  const spend = (hash: string, usd: number) => {
    const key = keys.get(hash);
    if (!key) {
      throw new Error(`no key ${hash}`);
    }
    key.usage += usd;
    key.usage_monthly += usd;
    key.limit_remaining = key.limit === null ? null : Math.max(0, key.limit - key.usage_monthly);
  };

  /** Simulates inference spend against the shared key. */
  const spendShared = (usd: number) => {
    sharedUsage += usd;
  };

  return { fetch, keys, calls, spend, spendShared };
}
