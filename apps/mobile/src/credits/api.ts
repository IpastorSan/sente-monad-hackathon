/**
 * HTTP client for `services/api`'s `/credits` (SEN-183): the user's free tier
 * of model credits, where it went, and the plans that would top it up.
 *
 * Built like `ProfileApi`: the shared session token, one silent
 * re-authentication on a 401, the API's `{statusCode, reason, message}` body
 * surfaced as a typed error. Answers are parsed rather than trusted: a field
 * of the wrong shape becomes a safe default (a missing run, a closed shop),
 * never a crash on the screen that is supposed to explain the bill.
 */
import { unboundFetch } from '../platform/fetch.ts';
import { API_URL, type SessionAuth } from '../wallet/api.ts';

export type LimitReset = 'daily' | 'weekly' | 'monthly' | null;

export type AgentUsage = {
  agentId: string;
  name: string;
  runs: number;
  costUsd: number;
  /** Unix epoch milliseconds. */
  lastRunAt: number;
};

export type RecentRun = {
  runId: string;
  agentId: string;
  agentName: string;
  trigger: 'manual' | 'schedule';
  model: string;
  status: string;
  stopReason: string | null;
  /** Unix epoch milliseconds. */
  startedAt: number;
  /** Null when no response in the run reported a cost. */
  costUsd: number | null;
};

/** `GET /credits`. */
export type CreditsOverview = {
  tier: 'free';
  provisioned: boolean;
  mode: 'per-user' | 'shared';
  freeTierUsd: number;
  /** Null = no limit (never set by Sente). */
  limitUsd: number | null;
  remainingUsd: number | null;
  usedUsd: number;
  reset: { period: LimitReset; resetsAt: string | null; summary: string };
  usage: {
    windowStart: string | null;
    byAgent: AgentUsage[];
    attributedUsd: number;
    unattributedUsd: number | null;
    recentRuns: RecentRun[];
    note: string;
  };
};

export type CreditPlan = { id: string; usd: number | null };

/** `GET /credits/plans`. */
export type CreditPlans = {
  purchasesEnabled: boolean;
  note: string | null;
  freeTier: { usd: number; reset: LimitReset };
  plans: CreditPlan[];
  custom: { minUsd: number; maxUsd: number };
  autoTopUp: { thresholdsUsd: number[]; amountsUsd: number[] };
  paymentAssets: string[];
};

/** Shown when the server does not say why buying is off. Mirrors `PURCHASES_CLOSED_NOTE`. */
export const PURCHASES_CLOSED_NOTE = 'Purchases open after the testnet demo.';

/** The answer when `GET /credits/plans` is missing or unreadable: the shop is shut, never open. */
export const CLOSED_PLANS: CreditPlans = {
  purchasesEnabled: false,
  note: PURCHASES_CLOSED_NOTE,
  freeTier: { usd: 10, reset: null },
  plans: [
    { id: 'pack_10', usd: 10 },
    { id: 'pack_20', usd: 20 },
    { id: 'pack_50', usd: 50 },
    { id: 'custom', usd: null },
  ],
  custom: { minUsd: 5, maxUsd: 500 },
  autoTopUp: { thresholdsUsd: [1, 2, 5], amountsUsd: [10, 20, 50] },
  paymentAssets: ['USDC', 'AUSD'],
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const RESETS: readonly LimitReset[] = ['daily', 'weekly', 'monthly', null];
const reset = (value: unknown): LimitReset =>
  RESETS.includes(value as LimitReset) ? (value as LimitReset) : null;

function parseAgentUsage(value: unknown): AgentUsage | null {
  if (!isObject(value)) return null;
  const agentId = str(value.agentId);
  const costUsd = num(value.costUsd);
  if (agentId === null || costUsd === null) return null;
  return {
    agentId,
    name: str(value.name) ?? 'Agent',
    runs: num(value.runs) ?? 0,
    costUsd,
    lastRunAt: num(value.lastRunAt) ?? 0,
  };
}

function parseRun(value: unknown): RecentRun | null {
  if (!isObject(value)) return null;
  const runId = str(value.runId);
  const agentId = str(value.agentId);
  const startedAt = num(value.startedAt);
  if (runId === null || agentId === null || startedAt === null) return null;
  return {
    runId,
    agentId,
    agentName: str(value.agentName) ?? 'Agent',
    trigger: value.trigger === 'manual' ? 'manual' : 'schedule',
    model: str(value.model) ?? '',
    status: str(value.status) ?? 'ended',
    stopReason: str(value.stopReason),
    startedAt,
    costUsd: num(value.costUsd),
  };
}

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter((item): item is T => item !== null) : [];
}

/** The wire body, or null when it is not a credits answer at all. */
export function parseOverview(body: unknown): CreditsOverview | null {
  if (!isObject(body)) return null;
  const usedUsd = num(body.usedUsd) ?? num(body.usageMonthUsd);
  if (usedUsd === null) return null;
  const resetBody = isObject(body.reset) ? body.reset : {};
  const usage = isObject(body.usage) ? body.usage : {};
  return {
    tier: 'free',
    provisioned: body.provisioned !== false,
    mode: body.mode === 'shared' ? 'shared' : 'per-user',
    freeTierUsd: num(body.freeTierUsd) ?? num(body.limitUsd) ?? 0,
    limitUsd: num(body.limitUsd),
    remainingUsd: num(body.remainingUsd),
    usedUsd,
    reset: {
      period: reset(resetBody.period),
      resetsAt: str(resetBody.resetsAt) ?? str(body.resetsAt),
      summary: str(resetBody.summary) ?? '',
    },
    usage: {
      windowStart: str(usage.windowStart),
      byAgent: list(usage.byAgent, parseAgentUsage),
      attributedUsd: num(usage.attributedUsd) ?? 0,
      unattributedUsd: num(usage.unattributedUsd),
      recentRuns: list(usage.recentRuns, parseRun),
      note: str(usage.note) ?? '',
    },
  };
}

const numbers = (value: unknown, fallback: number[]): number[] => {
  const parsed = Array.isArray(value) ? value.map(num).filter((n): n is number => n !== null) : [];
  return parsed.length > 0 ? parsed : fallback;
};

/** The plans, with anything unreadable falling back to the closed shop. */
export function parsePlans(body: unknown): CreditPlans {
  if (!isObject(body)) return CLOSED_PLANS;
  const plans = Array.isArray(body.plans)
    ? body.plans
        .filter(isObject)
        .map((plan) => ({ id: str(plan.id) ?? '', usd: num(plan.usd) }))
        .filter((plan) => plan.id !== '')
    : [];
  const custom = isObject(body.custom) ? body.custom : {};
  const autoTopUp = isObject(body.autoTopUp) ? body.autoTopUp : {};
  const freeTier = isObject(body.freeTier) ? body.freeTier : {};
  const enabled = body.purchasesEnabled === true;
  return {
    purchasesEnabled: enabled,
    note: enabled ? null : (str(body.note) ?? PURCHASES_CLOSED_NOTE),
    freeTier: {
      usd: num(freeTier.usd) ?? CLOSED_PLANS.freeTier.usd,
      reset: 'reset' in freeTier ? reset(freeTier.reset) : CLOSED_PLANS.freeTier.reset,
    },
    plans: plans.length > 0 ? plans : CLOSED_PLANS.plans,
    custom: {
      minUsd: num(custom.minUsd) ?? CLOSED_PLANS.custom.minUsd,
      maxUsd: num(custom.maxUsd) ?? CLOSED_PLANS.custom.maxUsd,
    },
    autoTopUp: {
      thresholdsUsd: numbers(autoTopUp.thresholdsUsd, CLOSED_PLANS.autoTopUp.thresholdsUsd),
      amountsUsd: numbers(autoTopUp.amountsUsd, CLOSED_PLANS.autoTopUp.amountsUsd),
    },
    paymentAssets: Array.isArray(body.paymentAssets)
      ? body.paymentAssets.map(str).filter((s): s is string => s !== null)
      : CLOSED_PLANS.paymentAssets,
  };
}

export class CreditsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'CreditsApiError';
    this.status = status;
    this.reason = reason;
  }
}

export type CreditsApiOptions = {
  auth: SessionAuth;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class CreditsApi {
  private readonly baseUrl: string;
  private readonly auth: SessionAuth;
  private readonly fetchImpl: typeof fetch;

  constructor({ auth, baseUrl = API_URL, fetchImpl = unboundFetch }: CreditsApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  /** `GET /credits` */
  async overview(): Promise<CreditsOverview> {
    const parsed = parseOverview(await this.request('/credits'));
    if (parsed === null) throw new CreditsApiError(200, undefined, 'Unreadable credits answer');
    return parsed;
  }

  /**
   * `GET /credits/plans`. A server without the route (a 404 from an older
   * deploy) reads as the closed shop rather than an error: the page still
   * shows the free tier.
   */
  async plans(): Promise<CreditPlans> {
    try {
      return parsePlans(await this.request('/credits/plans'));
    } catch (error) {
      if (error instanceof CreditsApiError && error.status === 404) return CLOSED_PLANS;
      throw error;
    }
  }

  /** One GET, and at most one silent re-authentication — see `WalletApi`. */
  private async request(path: string): Promise<unknown> {
    const token = this.auth.token();
    if (token === null) return this.read(await this.send(path, await this.auth.refresh()));
    const first = await this.send(path, token);
    if (first.status !== 401) return this.read(first);
    const refreshed = await this.auth.refresh();
    if (refreshed === null) return this.read(first);
    return this.read(await this.send(path, refreshed));
  }

  private send(path: string, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers });
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
      throw new CreditsApiError(response.status, detail?.reason, message);
    }
    return parsed;
  }
}
