/**
 * A small `fetch` client over OpenRouter's key-management API
 * (`/api/v1/keys`), authenticated with the MANAGEMENT key.
 *
 * Deliberately standalone — no Nest, no relative imports, erasable syntax only
 * — so `scripts/openrouter-probe.ts` can load this exact file under node's
 * native type stripping. What the probe exercises is what the API ships.
 *
 * Secrets: the management key goes in the Authorization header and nowhere
 * else; `OpenRouterApiError` messages carry the status and OpenRouter's own
 * error text, never a request header. The plaintext `key` of a new API key is
 * returned exactly once, by `createKey`.
 */

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/** The subset of `fetch` this client uses, so tests can hand it a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LimitReset = 'daily' | 'weekly' | 'monthly' | null;

/** One API key as the management API describes it. Money fields are in USD. */
export interface OpenRouterKey {
  hash: string;
  name: string;
  label: string;
  disabled: boolean;
  /** Hard spending limit, or null for unlimited. */
  limit: number | null;
  /** What is left of `limit` in the current reset window, or null when unlimited. */
  limit_remaining: number | null;
  limit_reset: LimitReset;
  include_byok_in_limit: boolean;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  created_at: string;
  updated_at: string | null;
  expires_at?: string | null;
  external_user?: string | null;
}

export interface CreateKeyInput {
  name: string;
  /** USD. */
  limit: number;
  limit_reset?: LimitReset;
  include_byok_in_limit?: boolean;
  /** ISO 8601 with seconds. A key past this instant stops working; the probe's dead-man switch. */
  expires_at?: string;
  /** Our end-user id, for attribution in OpenRouter's dashboard. Echoed back as `external_user`. */
  external?: { user: string };
}

export interface CreatedKey {
  /** The plaintext `sk-or-...` key. Only ever returned here. */
  key: string;
  data: OpenRouterKey;
}

export interface UpdateKeyInput {
  name?: string;
  limit?: number | null;
  limit_reset?: LimitReset;
  include_byok_in_limit?: boolean;
  disabled?: boolean;
}

/** The four operations `CreditsService` needs; the seam tests and wiring bind. */
export interface OpenRouterKeyApi {
  createKey(input: CreateKeyInput): Promise<CreatedKey>;
  getKey(hash: string): Promise<OpenRouterKey>;
  updateKey(hash: string, input: UpdateKeyInput): Promise<OpenRouterKey>;
  deleteKey(hash: string): Promise<void>;
}

export class OpenRouterApiError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenRouterApiError';
    this.status = status;
  }
}

export interface OpenRouterManagementClientOptions {
  managementKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

/** Keep upstream error text short: it lands in logs and HTTP error bodies. */
const MAX_ERROR_TEXT = 300;

export class OpenRouterManagementClient implements OpenRouterKeyApi {
  private readonly managementKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: OpenRouterManagementClientOptions) {
    if (!options.managementKey.trim()) {
      throw new Error('OpenRouterManagementClient needs a management key');
    }
    this.managementKey = options.managementKey.trim();
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE).replace(/\/+$/, '');
  }

  async createKey(input: CreateKeyInput): Promise<CreatedKey> {
    const body = await this.request('POST', '/keys', input);
    const created = body as Partial<CreatedKey> | null;
    if (typeof created?.key !== 'string' || !created.key || !isKey(created.data)) {
      // Never echo the body: on success it contains the plaintext key.
      throw new OpenRouterApiError(200, 'POST /keys: response has no key or key data');
    }
    return { key: created.key, data: created.data };
  }

  async getKey(hash: string): Promise<OpenRouterKey> {
    return unwrapKey('GET /keys/:hash', await this.request('GET', keyPath(hash)));
  }

  async updateKey(hash: string, input: UpdateKeyInput): Promise<OpenRouterKey> {
    return unwrapKey('PATCH /keys/:hash', await this.request('PATCH', keyPath(hash), input));
  }

  async deleteKey(hash: string): Promise<void> {
    await this.request('DELETE', keyPath(hash));
  }

  private async request(method: string, path: string, body?: object): Promise<unknown> {
    const label = `${method} ${path.startsWith('/keys/') ? '/keys/:hash' : path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.managementKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new OpenRouterApiError(0, `${label}: ${describeError(error)}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new OpenRouterApiError(
        response.status,
        `${label}: HTTP ${response.status} ${upstreamMessage(text)}`.trim(),
      );
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpenRouterApiError(response.status, `${label}: response is not JSON`);
    }
  }
}

function keyPath(hash: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(hash)) {
    throw new OpenRouterApiError(0, 'refusing a malformed key hash');
  }
  return `/keys/${hash}`;
}

function unwrapKey(label: string, body: unknown): OpenRouterKey {
  const data = (body as { data?: unknown } | null)?.data;
  if (!isKey(data)) {
    throw new OpenRouterApiError(200, `${label}: response has no key data`);
  }
  return data;
}

function isKey(value: unknown): value is OpenRouterKey {
  const key = value as Partial<OpenRouterKey> | null | undefined;
  return (
    typeof key === 'object' &&
    key !== null &&
    typeof key.hash === 'string' &&
    typeof key.usage_monthly === 'number' &&
    (key.limit === null || typeof key.limit === 'number')
  );
}

/** OpenRouter errors look like `{"error":{"code":401,"message":"..."}}`. */
function upstreamMessage(text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') {
      message = parsed.error.message;
    }
  } catch {
    // Not JSON; fall through with the raw text.
  }
  return message.replace(/\s+/g, ' ').slice(0, MAX_ERROR_TEXT);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `GET /api/v1/key` reports about the inference key making the request. Money in USD. */
export interface CurrentKeyInfo {
  label: string;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset?: LimitReset;
  usage: number;
  usage_monthly?: number;
}

/** The one operation shared-key mode needs (SEN-18). */
export interface SharedKeyApi {
  currentKey(): Promise<CurrentKeyInfo>;
}

export interface OpenRouterSharedKeyClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

/** Reads the shared inference key's own limit and usage. Never returns or logs the key. */
export class OpenRouterSharedKeyClient implements SharedKeyApi {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: OpenRouterSharedKeyClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error('OpenRouterSharedKeyClient needs an API key');
    }
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE).replace(/\/+$/, '');
  }

  async currentKey(): Promise<CurrentKeyInfo> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/key`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (error) {
      throw new OpenRouterApiError(0, `GET /key: ${describeError(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new OpenRouterApiError(
        response.status,
        `GET /key: HTTP ${response.status} ${upstreamMessage(text)}`.trim(),
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new OpenRouterApiError(response.status, 'GET /key: response is not JSON');
    }
    const data = (body as { data?: Partial<CurrentKeyInfo> } | null)?.data;
    if (!data || typeof data.usage !== 'number') {
      throw new OpenRouterApiError(response.status, 'GET /key: response has no key data');
    }
    return {
      label: typeof data.label === 'string' ? data.label : '',
      limit: typeof data.limit === 'number' ? data.limit : null,
      limit_remaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
      limit_reset: data.limit_reset ?? null,
      usage: data.usage,
      ...(typeof data.usage_monthly === 'number' ? { usage_monthly: data.usage_monthly } : {}),
    };
  }
}
