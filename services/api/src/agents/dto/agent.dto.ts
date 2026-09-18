// The `@Type` decorators below read Reflect metadata at module-load time, and
// this DTO is imported by the tool registry too — so the polyfill must load
// with it, not just with main.ts (same first-line import as main.ts).
import 'reflect-metadata';

import { MANDATE_CHAIN_ID, type Mandate } from '@sente/mandate';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { CommitTimes, ConsensusState } from '../../chain/consensus.service';
import type { AgentEvent, AgentEventKind } from '../events/agent-event-log';
import { AGENT_EVENT_KINDS } from '../events/agent-event-log';
import type { AgentRecord, AgentStatus } from '../store/agent-store';

export const AGENT_NAME_MAX_LENGTH = 64;
export const AGENT_SYSTEM_PROMPT_MAX_LENGTH = 8_000;
export const AGENT_STRATEGY_MAX_LENGTH = 2_000;

/**
 * NOTE on identity, as in `wallet/dto`: there is deliberately no `userId`
 * field anywhere. The owner comes from the auth guard, and the global
 * ValidationPipe runs with `forbidNonWhitelisted`, so a body that smuggles one
 * in is a 400 rather than silently ignored.
 *
 * The mandate is only checked to be an object here. `parseMandate` is its
 * validator — one implementation, shared with every other caller — and the
 * service runs it, so a bad mandate is refused with `mandate_invalid` and the
 * field that failed.
 */
export class CreateAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_NAME_MAX_LENGTH)
  @Matches(/\S/, { message: 'name must not be blank' })
  name!: string;

  @IsString()
  @MaxLength(AGENT_SYSTEM_PROMPT_MAX_LENGTH)
  systemPrompt!: string;

  @IsString()
  @MaxLength(AGENT_STRATEGY_MAX_LENGTH)
  strategy!: string;

  /**
   * An OpenRouter model id. The allowlist (`AGENT_MODELS`) is checked by the
   * service, so a refusal carries the stable reason `model_not_allowed`.
   */
  @IsString()
  @MaxLength(128)
  model!: string;

  /**
   * Atoms as decimal strings, never JS numbers — the form `parseMandate` accepts.
   */
  @IsObject()
  mandate!: Record<string, unknown>;

  /**
   * Publish this agent's system prompt so other people can fork it with your
   * instructions (SEN-28). Omitted means `false`. The STRATEGY is copyable by
   * forking either way — this gates the prompt, not the idea.
   */
  @IsOptional()
  @IsBoolean()
  'public'?: boolean;
}

export class AmendMandateDto {
  @IsObject()
  mandate!: Record<string, unknown>;
}

/**
 * `POST /agents/:id/fork` (SEN-28): the caller's OWN mandate for a copy of
 * another agent's strategy.
 *
 * There is no `strategy`, `systemPrompt` or `model` field, and `forbidNonWhitelisted`
 * makes that a 400: the API takes those from the source agent, so a caller
 * cannot fork an agent and smuggle in a different strategy under its name.
 */
export class ForkAgentDto {
  /** The forker's mandate. The copy's policy is compiled from THIS, never the source's. */
  @IsObject()
  mandate!: Record<string, unknown>;

  /** The new agent's name. Omitted means `<source name> (fork)`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_NAME_MAX_LENGTH)
  @Matches(/\S/, { message: 'name must not be blank' })
  name?: string;
}

export class AgentIdParamDto {
  @IsUUID('4')
  id!: string;
}

export const AGENT_RUN_INSTRUCTION_MAX_LENGTH = 2_000;

/** `POST /agents/:id/run`. The instruction is untrusted guidance, fenced in the prompt. */
export class RunAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(AGENT_RUN_INSTRUCTION_MAX_LENGTH)
  instruction?: string;
}

/**
 * Page size when the client omits `limit`, and its hard ceiling.
 *
 * `GET /agents/:id/events`. Query values arrive as strings, so the numeric
 * ones carry `@Type(() => Number)` for the global pipe's `transform` step.
 * `kind` is checked against `AGENT_EVENT_KINDS` — a typo is a 400 here, not a
 * silently-empty page later.
 */
export const AGENT_EVENTS_DEFAULT_LIMIT = 100;
export const AGENT_EVENTS_MAX_LIMIT = 500;

export class AgentEventsQueryDto {
  /** Event-log cursor: return only events with `seq > afterSeq`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number;

  /** Optional filter, e.g. only `fill` records for the Ledger. */
  @IsOptional()
  @IsIn(AGENT_EVENT_KINDS)
  kind?: AgentEventKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AGENT_EVENTS_MAX_LIMIT)
  limit?: number;
}

// ---------------------------------------------------------------------------
// Responses. Every bigint crosses the wire as a decimal string.
// ---------------------------------------------------------------------------

/** A mandate on the wire. Exactly the shape `parseMandate` accepts back. */
export interface MandateDto {
  version: number;
  chainId: number;
  expiresAt: number;
  venues: string[];
  kuru: { markets: string[]; maxDepositAtoms: Record<string, string> };
  perpl: { maxCollateralAtoms: string; maxLeverage: number; markets: string[] };
  maxOrderNotional: string;
  rollingCap?: { windowSeconds: number; capAtoms: string; token: string };
  /** The one address the agent's wallet may send ERC-20s to: its owner's. */
  returnTo?: string;
}

export interface AgentResponseDto {
  id: string;
  name: string;
  systemPrompt: string;
  strategy: string;
  model: string;
  mandate: MandateDto;
  /**
   * Whether the owner published the system prompt (SEN-28): forking copies it
   * only when this is true, and a fork always starts `false` itself.
   */
  public: boolean;
  /** The agent this one's strategy was forked from (SEN-28), when there is one. */
  forkedFrom?: string;
  /**
   * The agent's wallet. Fund its collateral with an ERC-20 transfer; the
   * server only drips MON for gas, at hire (`gasFunded`).
   */
  address: string;
  chainId: number;
  walletId: string;
  policyId: string;
  status: AgentStatus;
  /** Only once revoked: whether the enclave policy has been emptied. */
  policyCleared?: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  /** Whether the server's gas drip sent this wallet MON at hire. If not, fund gas by hand. */
  gasFunded: boolean;
  /**
   * Only when `gasFunded` is false. A stable string: one of
   * `AGENT_DRIP_REFUSAL_REASONS` (gas/gas.errors.ts), `gas_drip_unavailable`
   * or `drip_pending`.
   */
  gasFundingReason?: string;
  /** The drip transaction, when one was broadcast. */
  gasFundingTxHash?: string;
}

export interface HireAgentResponseDto {
  agent: AgentResponseDto;
  /**
   * The agent's MCP bearer token. Returned by this response ONLY — the server
   * keeps just its hash, so it cannot be shown again. A fork answers with this
   * same shape: the copy is a real, separately-credentialled agent.
   */
  mcpToken: string;
}

export interface AgentListResponseDto {
  agents: AgentResponseDto[];
}

/**
 * One event on the wire — the log's shape with the bigint-free guarantee made
 * explicit. The Agent Ledger, verdicts and consensus ramp all read through
 * this route, so field names here are API surface: `seq`, `kind`, `at`,
 * `detail` and every key inside `detail` are kept stable on purpose.
 */
export interface AgentEventResponseDto {
  seq: number;
  agentId: string;
  runId?: string;
  at: number;
  kind: AgentEventKind;
  layer?: string;
  tool?: string;
  /** JSON-safe: the log already stored bigints as decimal strings. */
  detail: Record<string, unknown>;
  /**
   * Where Monad has taken `detail.blockNumber` (SEN-21). Present on every event
   * that names a block — `order`, `fill` and `close` today — and on nothing
   * else: a thesis or a refusal has no block to ask about.
   *
   * This is what the Ledger's ramp draws from (SEN-35). It polls
   * `GET /chain/blocks/:n/consensus` only while the state here is not yet
   * final, so a screenful of settled trades asks for nothing.
   */
  consensus?: AgentEventConsensusDto;
}

/** The consensus ramp's per-event input: current state, and when each state landed. */
export interface AgentEventConsensusDto {
  /** `Proposed` | `Voted` | `Finalized` | `Verified`, or `unknown` for a block outside the window. */
  state: ConsensusState;
  /** Epoch ms each commit state was first observed; empty when `state` is `unknown`. */
  at: CommitTimes;
}

export interface AgentEventsResponseDto {
  events: AgentEventResponseDto[];
  /**
   * The highest `seq` in this page — pass it back as `afterSeq` for the next
   * one. Equals the request cursor when the page is empty.
   */
  nextSeq: number;
}

export function toAgentEventResponse(event: AgentEvent): AgentEventResponseDto {
  return {
    seq: event.seq,
    agentId: event.agentId,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    at: event.at,
    kind: event.kind,
    ...(event.layer !== undefined ? { layer: event.layer } : {}),
    ...(event.tool !== undefined ? { tool: event.tool } : {}),
    detail: { ...event.detail },
  };
}

export function toMandateDto(mandate: Mandate): MandateDto {
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
    ...(mandate.returnTo ? { returnTo: mandate.returnTo } : {}),
  };
}

/** Never includes `mcpTokenHash` or `userId`: the caller is the owner. */
export function toAgentResponse(agent: AgentRecord): AgentResponseDto {
  return {
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    strategy: agent.strategy,
    model: agent.model,
    mandate: toMandateDto(agent.mandate),
    public: agent.public,
    ...(agent.forkedFrom !== undefined ? { forkedFrom: agent.forkedFrom } : {}),
    address: agent.address,
    chainId: MANDATE_CHAIN_ID,
    walletId: agent.walletId,
    policyId: agent.policyId,
    status: agent.status,
    ...(agent.status === 'revoked' ? { policyCleared: agent.policyCleared } : {}),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    ...(agent.revokedAt ? { revokedAt: agent.revokedAt.toISOString() } : {}),
    ...toGasFundingFields(agent),
  };
}

function toGasFundingFields(
  agent: AgentRecord,
): Pick<AgentResponseDto, 'gasFunded' | 'gasFundingReason' | 'gasFundingTxHash'> {
  const funding = agent.gasFunding;
  if (!funding) return { gasFunded: false, gasFundingReason: 'gas_drip_unavailable' };
  return {
    gasFunded: funding.funded,
    ...(funding.funded ? {} : { gasFundingReason: funding.reason ?? 'drip_failed' }),
    ...(funding.txHash ? { gasFundingTxHash: funding.txHash } : {}),
  };
}
