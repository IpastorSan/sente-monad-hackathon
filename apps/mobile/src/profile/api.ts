/**
 * HTTP client for `services/api`'s `/profile` (SEN-172): the user's chosen
 * name and avatar seed, `null` for "the default derived from the address".
 *
 * Built like `MarketsApi`: the shared session token, one silent
 * re-authentication on a 401, the API's `{statusCode, reason, message}` error
 * body surfaced as a typed error. The answer is parsed rather than trusted —
 * a field of the wrong shape reads as the default, never as a crash in the
 * header of every screen.
 */
import { unboundFetch } from '../platform/fetch.ts';
import { API_URL, type SessionAuth } from '../wallet/api.ts';
import { AVATAR_SEED_PATTERN } from './rules.ts';

/** The overrides. `null` = use the deterministic default. */
export type Profile = { name: string | null; avatarSeed: string | null };

/** What `PATCH /profile` takes: a field left out is unchanged, `null` resets it. */
export type ProfilePatch = Partial<Profile>;

export const DEFAULT_PROFILE: Profile = { name: null, avatarSeed: null };

/** The wire body as a `Profile`, with anything malformed read as the default. */
export function parseProfile(body: unknown): Profile {
  if (typeof body !== 'object' || body === null) return DEFAULT_PROFILE;
  const { name, avatarSeed } = body as Record<string, unknown>;
  return {
    name: typeof name === 'string' && name.trim().length > 0 ? name : null,
    avatarSeed:
      typeof avatarSeed === 'string' && AVATAR_SEED_PATTERN.test(avatarSeed) ? avatarSeed : null,
  };
}

export class ProfileApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'ProfileApiError';
    this.status = status;
    this.reason = reason;
  }
}

export type ProfileApiOptions = {
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class ProfileApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  constructor({ auth, baseUrl = API_URL, fetchImpl = unboundFetch }: ProfileApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** `GET /profile` */
  async get(): Promise<Profile> {
    return parseProfile(await this.request('GET'));
  }

  /** `PATCH /profile` — answers the whole profile after the change. */
  async update(patch: ProfilePatch): Promise<Profile> {
    return parseProfile(await this.request('PATCH', patch));
  }

  /** One request, and at most one silent re-authentication — see `WalletApi`. */
  private async request(method: 'GET' | 'PATCH', body?: ProfilePatch): Promise<unknown> {
    const token = this.auth.token();
    // No token yet (the first request after sign-in): sign in first rather
    // than spend a round trip on a certain 401. `refresh()` is single-flight.
    if (token === null) return this.read(await this.send(method, body, await this.auth.refresh()));
    const first = await this.send(method, body, token);
    if (first.status !== 401) return this.read(first);
    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read(first);
    return this.read(await this.send(method, body, refreshed));
  }

  private send(
    method: 'GET' | 'PATCH',
    body: ProfilePatch | undefined,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.baseUrl}/profile`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async read(response: Response): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      throw new ProfileApiError(response.status, detail?.reason, message);
    }
    return parsed;
  }
}
