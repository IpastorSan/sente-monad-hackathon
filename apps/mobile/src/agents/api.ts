/**
 * HTTP client for `services/api`'s `/agents` routes (SEN-5), plus the run
 * route SEN-8 will add.
 *
 * Same shape as `WalletApi` on purpose: the placeholder `x-sente-user-id`
 * header, JSON in and out, and every bigint crossing the wire as a decimal
 * string. The difference is that this client converts in BOTH directions, so
 * screens only ever hold bigint atoms and never a string they could mis-parse.
 *
 * No trust decisions live here. The mandate is validated by the API's
 * `parseMandate`; the client only shapes it.
 */
import type { Address } from 'viem';

import { API_URL, USER_ID_HEADER } from '../wallet/api.ts';

/** Mirrors `AGENT_MODELS` in `services/api/src/agents/agents.config.ts`. */
export const AGENT_MODELS = [
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
] as const;

export type AgentModelId = (typeof AGENT_MODELS)[number]['id'];

export function modelLabel(id: string): string {
  return AGENT_MODELS.find((model) => model.id === id)?.label ?? id;
}

/** Mirrors the DTO limits in `services/api/src/agents/dto/agent.dto.ts`. */
export const AGENT_LIMITS = {
  name: 64,
  systemPrompt: 8_000,
  strategy: 2_000,
} as const;

/** Mirrors `FORK_NAME_SUFFIX` in `services/api/src/agents/agents.service.ts`. */
export const FORK_NAME_SUFFIX = ' (fork)';

/**
 * `Night desk` -> `Night desk (fork)`, clamped to `AGENT_LIMITS.name`.
 *
 * Mirrors `forkName` in `services/api/src/agents/agents.service.ts`, which names
 * an unnamed fork this same way: this screen shows the name and SENDS it, so
 * what the user reads before hiring is the name the agent is stored under.
 */
export function forkName(sourceName: string): string {
  const room = AGENT_LIMITS.name - FORK_NAME_SUFFIX.length;
  return `${sourceName.trim().slice(0, room)}${FORK_NAME_SUFFIX}`;
}

export const MANDATE_VERSION = 1;
/** Monad testnet. Both venues are testnet-only today, so the mandate is too. */
export const MANDATE_CHAIN_ID = 10143;

export type VenueId = 'kuru' | 'perpl';

/** A mandate as the app holds it: atoms are bigints. */
export type AgentMandate = {
  version: typeof MANDATE_VERSION;
  chainId: typeof MANDATE_CHAIN_ID;
  /** Unix seconds. */
  expiresAt: number;
  venues: VenueId[];
  kuru: { markets: Address[]; maxDepositAtoms: Record<Address, bigint> };
  perpl: { maxCollateralAtoms: bigint; maxLeverage: number; markets: string[] };
  /** A decimal string in quote units, e.g. "250.5". Never a float. */
  maxOrderNotional: string;
  rollingCap?: { windowSeconds: number; capAtoms: bigint; token: Address };
};

/** A mandate on the wire: exactly the shape the API's `parseMandate` accepts. */
export type WireMandate = {
  version: number;
  chainId: number;
  expiresAt: number;
  venues: string[];
  kuru: { markets: string[]; maxDepositAtoms: Record<string, string> };
  perpl: { maxCollateralAtoms: string; maxLeverage: number; markets: string[] };
  maxOrderNotional: string;
  rollingCap?: { windowSeconds: number; capAtoms: string; token: string };
};

export type AgentStatus = 'active' | 'revoked';

type AgentFields = {
  id: string;
  name: string;
  systemPrompt: string;
  strategy: string;
  model: string;
  /**
   * Whether the owner published the system prompt (SEN-28). Forking copies it
   * only when this is true; the strategy is copyable either way.
   */
  public: boolean;
  /** The agent this one's strategy was forked from (SEN-28), if any. */
  forkedFrom?: string;
  /** The agent's own wallet. Funding it is a plain transfer from the user. */
  address: Address;
  chainId: number;
  walletId: string;
  policyId: string;
  status: AgentStatus;
  /** Only once revoked: whether the enclave policy has actually been emptied. */
  policyCleared?: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type Agent = AgentFields & { mandate: AgentMandate };
export type WireAgent = AgentFields & { mandate: WireMandate };

export type HireAgentRequest = {
  name: string;
  systemPrompt: string;
  strategy: string;
  model: string;
  mandate: AgentMandate;
  /**
   * Publish the system prompt so other people can fork it (SEN-28). Omitted
   * means `false`: sharing is opt-in, per agent.
   */
  public?: boolean;
};

/**
 * `POST /agents/:id/fork` (SEN-28). No `strategy`, `systemPrompt` or `model`:
 * the API takes those from the source agent. The only thing the caller writes
 * is the mandate that will bound their copy.
 */
export type ForkAgentRequest = {
  mandate: AgentMandate;
  /** Omitted, the API names the copy `<source name> (fork)`. */
  name?: string;
};

export type HireAgentResult = {
  agent: Agent;
  /** The agent's MCP bearer token. The API returns it this once and keeps only a hash. */
  mcpToken: string;
};

/** SEN-8's `RunResult`. Loose on purpose: the route does not exist yet. */
export type RunResult = {
  runId: string;
  stopReason: string;
  iterations: number;
  costUsd?: number;
};

export type RunOutcome =
  | { kind: 'completed'; result: RunResult }
  /** The API has no run route yet (SEN-8). Not an error in the agent. */
  | { kind: 'unavailable' };

/**
 * One event on the agent's trail, as `GET /agents/:id/events` returns it
 * (SEN-20). Bigints already crossed as decimal strings server-side, so
 * `detail` is JSON-safe as it stands.
 *
 * `kind` is a plain string rather than a union: `verdict` is SEN-22's and is
 * not in the API's `AGENT_EVENT_KINDS` yet, and the Ledger must not stop
 * compiling the day it lands. `src/agents/ledger.ts` is what narrows it.
 */
export type WireAgentEvent = {
  /** Increasing across the whole log, so it orders and pages stably. */
  seq: number;
  agentId: string;
  /** The run or MCP session that produced it. */
  runId?: string;
  /** Unix epoch milliseconds. */
  at: number;
  kind: string;
  /** Set on every refusal, and only on refusals. */
  layer?: string;
  tool?: string;
  detail: Record<string, unknown>;
};

export type AgentEventsPage = {
  /** Oldest first. */
  events: WireAgentEvent[];
  /** The highest `seq` in this page: hand it back as `afterSeq` for the next. */
  nextSeq: number;
};

/**
 * One row of `GET /leaderboard` (SEN-26).
 *
 * `n` is the denominator of `winRate` and `capitalDeployedUsd` of `roi`; the
 * API returns them together on purpose, and `src/agents/leaderboard.ts` is the
 * only thing that formats either one. Money is the API's own exact decimal
 * string, never a float.
 */
export type LeaderboardRow = {
  /** 1-based among the ranked rows; `null` for a row that is not ranked. */
  rank: number | null;
  agentId: string;
  name: string;
  model: string;
  /** One line: venues, markets, largest order. */
  mandate: string;
  /** The agent's own wallet, EIP-55. */
  address: Address;
  /** `kuru` | `perpl`: where the indexer holds an account for it. */
  venues: string[];
  /** `false` when the indexer holds no account for this address yet. */
  indexed: boolean;
  /** Settled trades: wins + losses. */
  n: number;
  wins: number;
  losses: number;
  /** Every indexed fill, entries included. */
  fills: number;
  /** `wins / n`, 0..1. `null` when nothing has settled. */
  winRate: number | null;
  realisedPnlUsd: string;
  capitalDeployedUsd: string;
  roi: number | null;
  /** The SEN-22 reading: per thesis, with its own denominator. */
  theses: { settled: number; held: number; open: number };
};

/** Whether the numbers exist at all. `unconfigured` and `unreachable` carry no rows. */
export type LeaderboardSource = {
  kind: 'ok' | 'unconfigured' | 'unreachable';
  message?: string;
};

export type Leaderboard = {
  /** Rows with at least `minTrades` settled trades, best first. */
  ranked: LeaderboardRow[];
  /** Rows below it: shown, never ordered. */
  tooFewTrades: LeaderboardRow[];
  /** The published definitions, verbatim. Printed under the table. */
  formula: string;
  notes: string[];
  minTrades: number;
  source: LeaderboardSource;
  generatedAt: string;
};

/** A non-2xx response, carrying the API's stable `reason` when it sent one. */
export class AgentsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = 'AgentsApiError';
    this.status = status;
    this.reason = reason;
  }
}

export type AgentsApiOptions = {
  /** Placeholder identity — the same value `WalletApi` sends (the owner address). */
  userId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class AgentsApi {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ userId, baseUrl = API_URL, fetchImpl = fetch }: AgentsApiOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.userId = userId;
    this.fetchImpl = fetchImpl;
  }

  async list(): Promise<Agent[]> {
    const { agents } = await this.request<{ agents: WireAgent[] }>('GET', '/agents');
    return agents.map(fromWireAgent);
  }

  async get(id: string): Promise<Agent> {
    return fromWireAgent(await this.request<WireAgent>('GET', `/agents/${encodeURIComponent(id)}`));
  }

  async hire(request: HireAgentRequest): Promise<HireAgentResult> {
    const { agent, mcpToken } = await this.request<{ agent: WireAgent; mcpToken: string }>(
      'POST',
      '/agents',
      {
        name: request.name,
        systemPrompt: request.systemPrompt,
        strategy: request.strategy,
        model: request.model,
        mandate: toWireMandate(request.mandate),
        ...(request.public !== undefined ? { public: request.public } : {}),
      },
    );
    return { agent: fromWireAgent(agent), mcpToken };
  }

  /**
   * `POST /agents/:id/fork` (SEN-28) — a NEW agent for the caller, carrying the
   * source's strategy and model and bounded by `mandate`: the caller's OWN, so
   * the copy can never sign with authority the source's owner granted.
   *
   * The source needs no ownership — forking a leaderboard agent is the feature —
   * and the answer is a `HireAgentResult` because a fork is a real agent: its
   * own wallet, its own policy, and its own MCP token, returned this once.
   */
  async fork(id: string, request: ForkAgentRequest): Promise<HireAgentResult> {
    const { agent, mcpToken } = await this.request<{ agent: WireAgent; mcpToken: string }>(
      'POST',
      `/agents/${encodeURIComponent(id)}/fork`,
      {
        mandate: toWireMandate(request.mandate),
        ...(request.name !== undefined ? { name: request.name } : {}),
      },
    );
    return { agent: fromWireAgent(agent), mcpToken };
  }

  async amendMandate(id: string, mandate: AgentMandate): Promise<Agent> {
    return fromWireAgent(
      await this.request<WireAgent>('PATCH', `/agents/${encodeURIComponent(id)}/mandate`, {
        mandate: toWireMandate(mandate),
      }),
    );
  }

  /** Permanent. Safe to retry, and retrying is how a failed policy clear is retried. */
  async revoke(id: string): Promise<Agent> {
    return fromWireAgent(
      await this.request<WireAgent>('POST', `/agents/${encodeURIComponent(id)}/revoke`),
    );
  }

  /**
   * `GET /agents/:id/events` (SEN-20) — the agent's trail.
   *
   * `afterSeq` is the cursor: only events with a higher `seq` come back, which
   * is what lets the Ledger tail the log without re-reading what it holds.
   * Omit it and the API returns the MOST RECENT page, not the oldest — the log
   * keeps the last `limit` matches and orders them oldest-first within it — so
   * a first call with no cursor lands on recent history rather than on the
   * agent's first day.
   */
  async events(id: string, afterSeq?: number, limit?: number): Promise<AgentEventsPage> {
    // Built by hand rather than with URLSearchParams: `size` is not in every
    // engine this runs on, and `String(undefined)` on the wire would be a 400.
    const query: string[] = [];
    if (afterSeq !== undefined) query.push(`afterSeq=${afterSeq}`);
    if (limit !== undefined) query.push(`limit=${limit}`);
    const page = await this.request<AgentEventsPage>(
      'GET',
      `/agents/${encodeURIComponent(id)}/events${query.length > 0 ? `?${query.join('&')}` : ''}`,
    );
    return {
      events: page.events ?? [],
      nextSeq: page.nextSeq ?? afterSeq ?? 0,
    };
  }

  /**
   * `POST /agents/:id/run` — SEN-8. Until that route ships, the API answers
   * Nest's own 404 with no `reason`, which this reports as `unavailable`. A 404
   * that DOES carry `agent_not_found` is a real answer about the agent, so it
   * still throws.
   */
  async run(id: string, instruction?: string): Promise<RunOutcome> {
    try {
      const result = await this.request<RunResult>(
        'POST',
        `/agents/${encodeURIComponent(id)}/run`,
        instruction ? { instruction } : undefined,
      );
      return { kind: 'completed', result };
    } catch (error) {
      if (error instanceof AgentsApiError && error.status === 404 && error.reason === undefined) {
        return { kind: 'unavailable' };
      }
      throw error;
    }
  }

  /**
   * `GET /leaderboard` (SEN-26) — every active agent, ranked on settled
   * performance, with `n` beside every win rate and the formulas published in
   * the response.
   *
   * The route is global, not per-user: it answers the same board whoever asks.
   * It is behind the placeholder header for now, like every other route.
   *
   * `source.kind` is not decoration. When it is `unconfigured` or
   * `unreachable` the lists are empty because there are no numbers to show —
   * not because nobody has traded — and the screen must say which.
   */
  async leaderboard(): Promise<Leaderboard> {
    const page = await this.request<Partial<Leaderboard>>('GET', '/leaderboard');
    return {
      ranked: page.ranked ?? [],
      tooFewTrades: page.tooFewTrades ?? [],
      formula: page.formula ?? '',
      notes: page.notes ?? [],
      minTrades: page.minTrades ?? 3,
      source: page.source ?? { kind: 'ok' },
      generatedAt: page.generatedAt ?? '',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        [USER_ID_HEADER]: this.userId,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const detail = parsed as { reason?: string; message?: string | string[] } | undefined;
      const message = Array.isArray(detail?.message)
        ? detail.message.join('; ')
        : (detail?.message ?? (text || response.statusText));
      throw new AgentsApiError(response.status, detail?.reason, message);
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

/** App (bigint atoms) -> wire (decimal strings). */
export function toWireMandate(mandate: AgentMandate): WireMandate {
  return {
    version: mandate.version,
    chainId: mandate.chainId,
    expiresAt: mandate.expiresAt,
    venues: [...mandate.venues],
    kuru: {
      markets: [...mandate.kuru.markets],
      maxDepositAtoms: Object.fromEntries(
        Object.entries(mandate.kuru.maxDepositAtoms).map(([token, cap]) => [token, cap.toString()]),
      ),
    },
    perpl: {
      maxCollateralAtoms: mandate.perpl.maxCollateralAtoms.toString(),
      maxLeverage: mandate.perpl.maxLeverage,
      markets: [...mandate.perpl.markets],
    },
    maxOrderNotional: mandate.maxOrderNotional,
    ...(mandate.rollingCap
      ? {
          rollingCap: {
            windowSeconds: mandate.rollingCap.windowSeconds,
            capAtoms: mandate.rollingCap.capAtoms.toString(),
            token: mandate.rollingCap.token,
          },
        }
      : {}),
  };
}

/** Wire (decimal strings) -> app (bigint atoms). */
export function fromWireMandate(wire: WireMandate): AgentMandate {
  return {
    version: MANDATE_VERSION,
    chainId: MANDATE_CHAIN_ID,
    expiresAt: wire.expiresAt,
    venues: wire.venues.filter((venue): venue is VenueId => venue === 'kuru' || venue === 'perpl'),
    kuru: {
      markets: wire.kuru.markets as Address[],
      maxDepositAtoms: Object.fromEntries(
        Object.entries(wire.kuru.maxDepositAtoms).map(([token, cap]) => [token, BigInt(cap)]),
      ) as Record<Address, bigint>,
    },
    perpl: {
      maxCollateralAtoms: BigInt(wire.perpl.maxCollateralAtoms),
      maxLeverage: wire.perpl.maxLeverage,
      markets: [...wire.perpl.markets],
    },
    maxOrderNotional: wire.maxOrderNotional,
    ...(wire.rollingCap
      ? {
          rollingCap: {
            windowSeconds: wire.rollingCap.windowSeconds,
            capAtoms: BigInt(wire.rollingCap.capAtoms),
            token: wire.rollingCap.token as Address,
          },
        }
      : {}),
  };
}

function fromWireAgent(wire: WireAgent): Agent {
  return { ...wire, mandate: fromWireMandate(wire.mandate) };
}

/**
 * Plain-language copy for a failed agents request. Keyed on the API's stable
 * `reason` strings (`AGENT_REFUSAL_REASONS` and friends in `agents.errors.ts`).
 */
export function describeAgentsError(error: unknown): { title: string; detail: string } {
  if (error instanceof AgentsApiError) {
    switch (error.reason) {
      case 'agent_not_found':
        return { title: 'Agent not found', detail: 'It may belong to a different account.' };
      case 'mandate_invalid':
        return { title: 'The API refused this mandate', detail: error.message };
      case 'model_not_allowed':
        return { title: 'That model isn’t available', detail: error.message };
      case 'agent_revoked':
        return {
          title: 'This agent is revoked',
          detail: 'Revoking is permanent. Hire a new agent instead.',
        };
      case 'wallet_provision_failed':
        return {
          title: 'The agent’s wallet couldn’t be created',
          detail: 'Nothing was saved. Try hiring again.',
        };
      case 'wallet_policy_update_failed':
        return {
          title: 'The enclave policy wasn’t updated',
          detail:
            'On an amend, the old mandate still stands. On a revoke, the agent is revoked but its ' +
            'wallet policy isn’t cleared yet; revoke again to retry.',
        };
      case 'agent_wallets_unconfigured':
        return {
          title: 'Agent wallets aren’t configured on this API',
          detail: 'The server has no Privy credentials. Set them and restart it.',
        };
      default:
        return { title: `The API answered ${error.status}`, detail: error.message };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: 'Couldn’t reach the API',
    detail: `${message}. On a phone, EXPO_PUBLIC_API_URL must be this machine’s LAN address.`,
  };
}
