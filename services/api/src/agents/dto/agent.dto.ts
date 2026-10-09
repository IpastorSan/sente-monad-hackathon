// The `@Type` decorators below read Reflect metadata at module-load time, and
// this DTO is imported by the tool registry too — so the polyfill must load
// with it, not just with main.ts (same first-line import as main.ts).
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';

import { MANDATE_CHAIN_ID, type AuthorizationPayload, type Mandate } from '@sente/mandate';
import { getPreset, type ParamValue } from '@sente/presets';
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import type { PreparedMandateChange } from '../agents.service';
import type { ReturnOutcome } from '../recovery/return-funds.service';
import type { CommitTimes, ConsensusState } from '../../chain/consensus.service';
import type { AgentEvent, AgentEventKind } from '../events/agent-event-log';
import { AGENT_EVENT_KINDS } from '../events/agent-event-log';
import type { AgentFillDto, FillVenue } from '../events/market-fills';
import type { AgentMandateOwnerMode } from '../agents.config';
import {
  AGENT_SCHEDULE_MAX_SECONDS,
  AGENT_SCHEDULE_MIN_SECONDS,
  type AgentRecord,
  type AgentStatus,
} from '../store/agent-store';

export const AGENT_NAME_MAX_LENGTH = 64;
export const AGENT_SYSTEM_PROMPT_MAX_LENGTH = 8_000;
export const AGENT_STRATEGY_MAX_LENGTH = 2_000;

/**
 * `PATCH /agents/:id/schedule` (SEN-67), and the optional `schedule` of a hire.
 * `null` clears the agent's own cadence (manual runs only, unless the global
 * `AGENT_TICK_SECONDS` is set). The field itself is required: `{}` is a 400,
 * so a client cannot clear a schedule by forgetting to send one.
 */
export class ScheduleDto {
  @ValidateIf((body: ScheduleDto) => body.everySeconds !== null)
  @IsInt()
  @Min(AGENT_SCHEDULE_MIN_SECONDS)
  @Max(AGENT_SCHEDULE_MAX_SECONDS)
  everySeconds!: number | null;
}

export const PRESET_ID_MAX_LENGTH = 64;

/**
 * A hire's `preset` (SEN-73): which catalog preset, and the params the user
 * set. Only the shape is checked here; `renderPreset` is the params' validator,
 * and the service refuses with `preset_invalid` and the failing keys.
 */
export class PresetRefDto {
  @IsString()
  @MinLength(1)
  @MaxLength(PRESET_ID_MAX_LENGTH)
  id!: string;

  /**
   * The catalog version the client showed the user. Optional; when sent and no
   * longer current, the hire is refused rather than rendered from a newer text
   * the user never previewed.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsObject()
  params!: Record<string, unknown>;
}

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

  /**
   * Required without a `preset`; with one, omitted means the preset's render.
   * Validated whenever present, so a preset hire cannot smuggle in an
   * oversized prompt (SEN-73).
   */
  @ValidateIf((body: CreateAgentDto) => !body.preset || body.systemPrompt !== undefined)
  @IsString()
  @MaxLength(AGENT_SYSTEM_PROMPT_MAX_LENGTH)
  systemPrompt?: string;

  /** As `systemPrompt`: required without a `preset`, the render's when omitted with one. */
  @ValidateIf((body: CreateAgentDto) => !body.preset || body.strategy !== undefined)
  @IsString()
  @MaxLength(AGENT_STRATEGY_MAX_LENGTH)
  strategy?: string;

  /**
   * Hire from a catalog preset (SEN-73). Text sent beside it overrides the
   * render and marks the agent `customized`.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PresetRefDto)
  preset?: PresetRefDto;

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

  /**
   * The owner ticked "I understand the agent can lose the funds I give it"
   * (SEN-177). Recorded as `riskAcknowledgedAt`; omitted records nothing.
   */
  @IsOptional()
  @IsBoolean()
  riskAcknowledged?: boolean;

  /**
   * Run on its own every `everySeconds` (SEN-67). Omitted, or `everySeconds:
   * null`, hires it with no cadence of its own.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule?: ScheduleDto;
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

  /** As on a hire (SEN-177). */
  @IsOptional()
  @IsBoolean()
  riskAcknowledged?: boolean;
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

/**
 * `GET /agents/activity` (SEN-56): how many of the newest events, across all
 * the caller's agents, to return. Smaller than the per-agent page on purpose —
 * this feeds a home-screen headline and a short list under it, not a ledger.
 */
export const AGENT_ACTIVITY_DEFAULT_LIMIT = 20;
export const AGENT_ACTIVITY_MAX_LIMIT = 50;

export class AgentActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AGENT_ACTIVITY_MAX_LIMIT)
  limit?: number;
}

/**
 * `GET /agents/fills` (SEN-157): one market's fills across the caller's
 * agents, for the asset chart's stones. Capped like the activity feed: the
 * chart shows a window, not a ledger.
 */
export const AGENT_FILLS_DEFAULT_LIMIT = 50;
export const AGENT_FILLS_MAX_LIMIT = 100;

export class AgentFillsQueryDto {
  @IsOptional()
  @IsIn(['kuru', 'perpl'])
  venue?: FillVenue;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  symbol?: string;

  /** Unix ms: only fills at or after it. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  since?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AGENT_FILLS_MAX_LIMIT)
  limit?: number;
}

export interface AgentFillsResponseDto {
  /** Newest first, across every agent the caller owns, revoked ones included. */
  fills: AgentFillDto[];
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
  /** ISO 8601. When the owner acknowledged the risks (SEN-177); absent if never. */
  riskAcknowledgedAt?: string;
  /** The agent's own run cadence (SEN-67); `null` when it has none. */
  schedule: { everySeconds: number } | null;
  /** The preset it was hired (or forked) from (SEN-73); `null` for a free-form agent. */
  preset: AgentPresetDto | null;
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

export interface AgentPresetDto {
  id: string;
  version: number;
  /** The catalog's display name; the id itself if the preset has left the catalog. */
  name: string;
  params: Record<string, ParamValue>;
  /** The strategy or system prompt differs from the preset's render of `params`. */
  customized: boolean;
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

/**
 * `GET /agents/summaries` (SEN-56): one per agent the caller owns, revoked ones
 * included — the same set `GET /agents` returns. Every figure is computed from
 * the agent's event log on each read (`events/summary.ts`), which also says
 * which event fields each one is read from.
 *
 * The mobile client is written against these field names: they are API
 * surface, like the event DTO's.
 */
export interface AgentSummaryDto {
  agentId: string;
  /** Fills that landed: count of `fill` events. */
  trades: number;
  /** Refusals, both layers (sente + enclave). */
  held: number;
  /** `thesis` events. */
  theses: number;
  /**
   * Sent only when the server's log has dropped some of the agent's oldest
   * events (SEN-159): `trades`, `held` and `theses` then count only what is
   * still held, i.e. everything since `since` (epoch ms). OPTIONAL so an older
   * client keeps working; one that knows it should say "since <date>" rather
   * than show the counts as the agent's whole history.
   */
  countsPartial?: { since: number };
  /**
   * Realised P&L summed from `verdict` events, as exact decimal strings in quote
   * units — Kuru's USDC and Perpl's AUSD summed as one unit, as the leaderboard
   * does. `'0'` when nothing has settled. `last24h` is the verdicts whose `at`
   * is within the last 24 hours.
   *
   * `allTimePartial` (SEN-129) is sent, as `true`, only when the server's log
   * has dropped some of the agent's oldest events: `allTime` then covers only
   * what is still held. OPTIONAL so a client that predates it keeps working;
   * one that knows it should show `allTime` as "at least"/partial.
   */
  pnl: { last24h: string; allTime: string; allTimePartial?: true };
  /** Max notional (quote units, decimal string) among the orders that landed; null if none. */
  largestOrderNotional: string | null;
  /** Epoch ms when the CURRENT mandate took effect: the hire, or the last committed amend. */
  mandateSince: number;
  /** The newest event that is not a `run`, exactly as an item of `GET /agents/:id/events`. */
  lastEvent: AgentEventResponseDto | null;
}

export interface AgentSummariesResponseDto {
  summaries: AgentSummaryDto[];
}

/** An event of `GET /agents/activity`: the events route's item, plus whose it is. */
export type AgentActivityEventDto = AgentEventResponseDto & { agentName: string };

export interface AgentActivityResponseDto {
  /** Newest first, across every agent the caller owns; `run` summaries left out. */
  events: AgentActivityEventDto[];
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
    ...(agent.riskAcknowledgedAt
      ? { riskAcknowledgedAt: agent.riskAcknowledgedAt.toISOString() }
      : {}),
    schedule: agent.schedule ? { everySeconds: agent.schedule.everySeconds } : null,
    preset: agent.preset
      ? {
          id: agent.preset.id,
          version: agent.preset.version,
          name: getPreset(agent.preset.id)?.name ?? agent.preset.id,
          params: { ...agent.preset.params },
          customized: agent.preset.customized,
        }
      : null,
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
