/**
 * HTTP client for `services/api`'s `/presets` routes (SEN-114, plan U-8).
 *
 * The routes are plan B-T16b and may not be deployed yet. The Agents tab
 * therefore never depends on them: the catalog falls back to the copy bundled
 * from `@sente/presets` (see `catalog.ts`), and a stats request that fails in
 * any way — a 404 from an API without the route, `preset_not_found` for a
 * preset the server does not know, a blip — leaves that card without a stats
 * line. A missing number is honest; a zero would not be.
 *
 * Built like `MarketsApi`: the same session token source, one silent
 * re-authentication on a 401, and the API's `{statusCode, reason, message}`
 * error body surfaced as a typed error.
 */
import type { ParamSpec, SuggestedMandate, VenueId } from '@sente/presets';

import { API_URL, type SessionAuth } from '../wallet/api.ts';

// ---------------------------------------------------------------------------
// Wire contract: plan-backend.md, "Wire contract → Presets". `ParamSpec` and
// `SuggestedMandate` are imported rather than copied because `@sente/presets`
// declares them as that contract field for field, and the API hands them out
// as they are — one definition cannot drift from itself.
// ---------------------------------------------------------------------------

export type Decimal = string;

export interface PresetDto {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: VenueId[];
  params: ParamSpec[];
  tools: string[];
  defaults: {
    params: Record<string, unknown>;
    strategy: string;
    systemPrompt: string;
    suggestedMandate: SuggestedMandate;
    suggestedCadenceSeconds: number;
  };
}

// GET /presets
export interface PresetsResponseDto {
  presets: PresetDto[];
}

// GET /presets/:id/stats
export interface PresetStatsDto {
  presetId: string;
  window: '30d';
  /** Active agents hired from this preset right now. */
  running: number;
  /** Agents on the preset active at any point in the window: the cohort. */
  n: number;
  minN: number;
  /** ≈ $ (USDC + AUSD as one); `null` when `n < minN`. */
  medianPnl30d: Decimal | null;
  /** A fraction (P&L ÷ capital); `null` below `minN`. Its sample is `returnN`, not `n`. */
  medianReturn30d: Decimal | null;
  returnN: number;
  customized: number;
  definition: string;
  notes: string[];
  asOf: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PresetsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'PresetsApiError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Every 404 reads as "unavailable" here, `preset_not_found` included: the
 * screen's answer to both is the same (no stats line), unlike `/markets`
 * where an unknown market is a real answer worth showing.
 */
export function isUnavailable(error: unknown): boolean {
  return error instanceof PresetsApiError && error.status === 404;
}

export type PresetsApiOptions = {
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class PresetsApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  // Wrapped, not bare `fetch`: called as `this.fetchImpl(...)` a browser throws
  // "Illegal invocation" (SEN-164); Hermes does not care either way.
  constructor({
    auth,
    baseUrl = API_URL,
    fetchImpl = (input, init) => fetch(input, init),
  }: PresetsApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** `GET /presets` — the catalog the server will accept a hire against. */
  list(): Promise<PresetsResponseDto> {
    return this.request('/presets');
  }

  /** `GET /presets/:id/stats` — the 30-day cohort, with its sample sizes. */
  stats(id: string): Promise<PresetStatsDto> {
    return this.request(`/presets/${encodeURIComponent(id)}/stats`);
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const first = await this.send(url, this.auth.token());
    if (first.status !== 401) return this.read<T>(first);

    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read<T>(first);
    return this.read<T>(await this.send(url, refreshed));
  }

  private send(url: string, token: string | null): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'GET',
      headers: token !== null ? { authorization: `Bearer ${token}` } : {},
    });
  }

  private async read<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;
    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      throw new PresetsApiError(response.status, detail?.reason, message);
    }
    return parsed as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
