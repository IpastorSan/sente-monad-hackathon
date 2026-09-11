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
