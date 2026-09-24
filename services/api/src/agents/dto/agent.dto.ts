// The `@Type` decorators below read Reflect metadata at module-load time, and
// this DTO is imported by the tool registry too — so the polyfill must load
// with it, not just with main.ts (same first-line import as main.ts).
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';

import { MANDATE_CHAIN_ID, type AuthorizationPayload, type Mandate } from '@sente/mandate';
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

import type { PreparedMandateChange } from '../agents.service';
import type { ReturnOutcome } from '../recovery/return-funds.service';
import type { CommitTimes, ConsensusState } from '../../chain/consensus.service';
import type { AgentEvent, AgentEventKind } from '../events/agent-event-log';
import { AGENT_EVENT_KINDS } from '../events/agent-event-log';
import type { AgentMandateOwnerMode } from '../agents.config';
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

/** base64 DER, as `privy-authorization-signature` carries it. Room for P-256 plus slack. */
export const MANDATE_SIGNATURE_MAX_LENGTH = 512;

/**
 * `PATCH /agents/:id/mandate` — one route, two shapes, decided by who owns the
 * mandate (SEN-43/SEN-44):
 *
 * - `{ mandate }` for a `ownerKind: 'server'` agent, whose policy this server
 *   signs for itself.
 * - `{ prepareId, signature }` for a `ownerKind: 'device'` agent: the id of a
 *   change from `POST /agents/:id/mandate/prepare`, and the owner's signature
 *   over the payload it returned. The mandate is not resent — the approved
 *   bytes are the ones the server is holding, and a second copy could differ
 *   from them.
 *
 * `forbidNonWhitelisted` makes an unknown field a 400; a body that is neither
 * shape, or both, is refused here with the same message for everyone.
 */
export class AmendMandateDto {
  @IsOptional()
  @IsObject()
  mandate?: Record<string, unknown>;

  @IsOptional()
  @IsUUID('4')
  prepareId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MANDATE_SIGNATURE_MAX_LENGTH)
  signature?: string;
}

/** `POST /agents/:id/mandate/prepare` — the mandate whose PATCH is to be signed. */
export class PrepareMandateDto {
  @IsObject()
  mandate!: Record<string, unknown>;
}

/**
 * `POST /agents/:id/revoke` — empty for a server-owned agent, or the prepared
 * revoke and its signature for a device-owned one.
 */
export class RevokeAgentDto {
  @IsOptional()
  @IsUUID('4')
  prepareId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MANDATE_SIGNATURE_MAX_LENGTH)
  signature?: string;
}

/**
 * The approval in a body, or `undefined` when there is none.
 *
 * Throws `BadRequestException` — the same 400 shape the global ValidationPipe
 * produces — on a body that is half an approval, or both shapes at once: a
 * `mandate` beside a signature reads as "change it to this", and the signature
 * covers the rules the server already holds, not those, so the two could differ
 * and one of them would be silently ignored.
 */
export function readMandateApproval(
  body: Pick<AmendMandateDto, 'mandate' | 'prepareId' | 'signature'>,
): { prepareId: string; signature: string } | undefined {
  if (body.prepareId === undefined && body.signature === undefined) return undefined;
  if (body.prepareId === undefined || body.signature === undefined) {
    throw new BadRequestException('prepareId and signature go together: send both, or neither');
  }
  if (body.mandate !== undefined) {
    throw new BadRequestException(
      'send either { mandate } or { prepareId, signature }: a signed change carries its own ' +
        'mandate, the one the prepare returned',
    );
  }
  return { prepareId: body.prepareId, signature: body.signature };
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

/**
 * `POST /agents/:id/return` (SEN-17) — send an agent's funds back to its owner.
 *
 * There is deliberately no recipient field. The destination is
 * `mandate.returnTo`, which this server resolved from the caller's own wallet at
 * hire and compiled into the enclave policy, so the only address this route can
 * pay is one the enclave would sign for anyway.
 */
export class ReturnFundsDto {
  /** A token symbol, e.g. `USDC`. Omitted: every asset the wallet holds. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  asset?: string;

  /**
   * Human units, e.g. `1.5` — not atoms, because this is the figure a person
   * typed. Only meaningful beside `asset`; omitted means all of it.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^\d+(\.\d+)?$/, { message: 'amount must be a positive decimal' })
  amount?: string;
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
  /**
   * The agent's id on the ERC-8004 Identity Registry (SEN-27), as a decimal
   * string — a uint256, so it is not a JS number. It is what a reputation
   * aggregator keys this agent by, together with the registry handle
   * `eip155:10143:0x8004A818…` (`agentRegistryId()` in
   * `agents/reputation/erc8004.ts`).
   *
   * ABSENT IS NORMAL, and it is not an error: ERC-8004 is optional
   * (`ERC8004_REGISTRAR_KEY` unset), and a registration that failed leaves the
   * hire successful with no id — the registrar is never retried, because a
   * second `register` would mint a second agent. So the Ledger shows the id
   * when there is one and says nothing when there is not.
   */
  erc8004AgentId?: string;
  status: AgentStatus;
  /**
   * WHO CAN CHANGE THIS AGENT'S MANDATE (SEN-43), and therefore whether
   * amending or revoking it needs a signature from this phone (SEN-44).
   *
   * - `device` — the key quorum holding the hirer's device key owns the policy.
   *   `PATCH /agents/:id/mandate` and `POST /agents/:id/revoke` take
   *   `{ prepareId, signature }` after a `/prepare` call, and refuse a plain
   *   mandate with `mandate_approval_required`.
   * - `server` — this server's mandate key owns it and signs the change itself
   *   (dev and demo mode). The one-step routes work; the prepare routes refuse
   *   with `mandate_approval_not_required`.
   *
   * The app branches on this, so it is API surface: an agent hired before it
   * existed reads `server`, which is what it was.
   */
  ownerKind: AgentMandateOwnerMode;
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
 * What the owner is being asked to approve (SEN-44). Prose and numbers for the
 * confirmation sheet — NOT the thing the phone decides from. The decision is
 * made against `payload.body`, which the phone recompiles from the mandate it
 * is holding before it signs; a summary is composed by the party the signature
 * exists to bind, so it can only ever be a label.
 */
export interface MandateChangeSummaryDto {
  kind: 'amend' | 'revoke';
  agentId: string;
  agentName: string;
  policyId: string;
  /** Rules the policy holds afterwards. Zero on a revoke: the wallet signs nothing. */
  ruleCount: number;
}

/**
 * The answer to a `/prepare` call: an id, the exact payload to sign, and what
 * it means.
 *
 * `payload` is the Privy authorization payload — `{version, method, url, body,
 * headers}` — and `payload.body` is the literal `PATCH /v1/policies/{id}` body
 * the server will send. Check it against the change you asked for before
 * signing: the `privy-app-id` header and the URL are part of the signed bytes
 * too, and the rules are the mandate itself.
 */
export interface PreparedMandateChangeDto {
  /** Single-use. Send it back with the signature to commit the change. */
  prepareId: string;
  payload: AuthorizationPayload;
  /** ISO 8601. After this, prepare again — the signature is over stale bytes. */
  expiresAt: string;
  summary: MandateChangeSummaryDto;
}

export function toPreparedMandateChangeResponse(
  prepared: PreparedMandateChange,
): PreparedMandateChangeDto {
  return {
    prepareId: prepared.prepareId,
    payload: prepared.payload,
    expiresAt: prepared.expiresAt.toISOString(),
    // The summary is already wire-shaped — it carries no bigints and no
    // mandate — so it crosses as it stands.
    summary: { ...prepared.summary },
  };
}

/**
 * What `POST /agents/:id/return` did (SEN-17): one entry per asset, each with
 * the transaction that moved it.
 *
 * `success` is read from each transaction's own receipt. An agent wallet is a
 * plain EOA, so the two legs are two transactions and one can land while the
 * other does not — which is why neither leg is summarised into a single verdict.
 */
export interface ReturnedAssetDto {
  asset: string;
  /** The Kuru collateral leg, when there was free collateral to take back. */
  withdrawn?: { amount: string; transactionHash: string; success: boolean };
  /** The transfer leg: what left for the owner's wallet. */
  returned?: { amount: string; transactionHash: string; success: boolean };
  /** Why nothing moved for this asset. Present exactly when both legs are absent. */
  skipped?: string;
}

export interface ReturnFundsResponseDto {
  agentId: string;
  /** Where the funds went: the owner's wallet, as the policy pins it. */
  returnTo: string;
  assets: ReturnedAssetDto[];
  /** MON of the agent's own gas the whole return cost, as a decimal string. */
  monSpent: string;
}

export function toReturnFundsResponse(outcome: ReturnOutcome): ReturnFundsResponseDto {
  return {
    agentId: outcome.agentId,
    returnTo: outcome.returnTo,
    // Amounts are already decimal strings, and hashes are hex: nothing here is a
    // bigint, so the outcome crosses as it stands.
    assets: outcome.assets.map((asset) => ({ ...asset })),
    monSpent: outcome.monSpent,
  };
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
   * that names a block — `order`, `fill`, `close` and `deposit` today — and on
   * nothing else: a thesis or a refusal has no block to ask about. The rule is
   * "names a block", not a list of kinds, so `deposit` (SEN-30) got its ramp
   * without a code change; the list here is illustration, not the condition.
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
    ...(agent.erc8004AgentId !== undefined ? { erc8004AgentId: agent.erc8004AgentId } : {}),
    status: agent.status,
    ownerKind: agent.ownerKind,
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
