/**
 * `GET /public/agents/:id` on the wire (SEN-193): the agent page anyone can
 * open without a passkey.
 *
 * WHY IT EXISTS. An agent's limits live in a Privy enclave policy that no
 * outsider can read, where competitors put theirs in contracts anyone can. This
 * page is the answer: the mandate in the same two ledgers the owner reads, with
 * the record that shows whether the agent stayed inside it.
 *
 * WHICH AGENTS. Every agent the store holds (`isPublished`). Every active agent
 * is already on the global leaderboard (name, model, mandate line, wallet) and
 * forkable by anyone signed in, so its mandate was never private; a revoked one
 * keeps its page, because its record is still true. The system prompt and the
 * strategy stay behind the owner's publish toggle (`AgentRecord.public`).
 *
 * BUILT AS AN ALLOWLIST. `toPublicAgent` copies named fields into a new object
 * and nothing else, so a field added to `AgentRecord` later does not leak here
 * by default. `public-agent.spec.ts` fails if any key outside
 * `PUBLIC_AGENT_KEYS` appears, and plants every private value (owner, Privy
 * ids, MCP token hash, the return address, a private prompt) to prove none of
 * them does.
 */
import { getPreset } from '@sente/presets';

import type { AgentFillDto } from '../events/market-fills';
import type { AgentEvent } from '../events/agent-event-log';
import type { AgentEventSummary } from '../events/summary';
import { toMandateDto, type MandateDto } from '../dto/agent.dto';
import type { AgentRecord } from '../store/agent-store';

/** How many fills and refusals the page lists, newest first. */
export const PUBLIC_RECENT_LIMIT = 20;

/** A refusal's message is the gate's own sentence; past this it is cut. */
export const PUBLIC_REFUSAL_MESSAGE_MAX = 240;

export type PublicAgentStatus = 'active' | 'revoked' | 'expired';

/** The mandate without `returnTo`: that is the owner's own wallet address. */
export type PublicMandateDto = Omit<MandateDto, 'returnTo'>;

/**
 * The on-chain anchor of the mandate's hash (SEN-194), when the agent has one:
 * the transaction that wrote it to the ERC-8004 registry. Read defensively —
 * SEN-194 adds it to the record, and an agent hired before it has none.
 */
export interface PublicMandateAnchorDto {
  mandateHash: string;
  policyHash?: string;
  status: 'active' | 'revoked';
  txHash: string;
  chainId: number;
  registry: string;
  agentTokenId: string;
  /** ISO 8601. */
  anchoredAt: string;
}

export interface PublicFillDto {
  venue: AgentFillDto['venue'];
  symbol: string;
  side: 'buy' | 'sell' | null;
  price: string | null;
  size: string;
  txHash: string | null;
  /** Unix ms. */
  at: number;
}

export interface PublicRefusalDto {
  /** Who refused: the enclave (layer 2) or Sente's own check (layer 1). */
  layer: 'enclave' | 'sente';
  /** The stable refusal code, e.g. `max_order_notional`. */
  code: string | null;
  /** One sentence, with the owner's address and internal ids taken out. */
  message: string | null;
  /** Unix ms. */
  at: number;
}

export interface PublicAgentDto {
  id: string;
  name: string;
  /** What the sigil is drawn from: the agent id, as everywhere in the app. */
  sigilSeed: string;
  /**
   * The owner as they chose to appear (SEN-172). `name` is `null` when they
   * never set one; the app then says "a Sente trader". The avatar seed is
   * never derived from their address.
   */
  owner: { name: string | null; avatarSeed: string };
  model: string;
  status: PublicAgentStatus;
  /** The agent's own wallet: public, it signs on chain. */
  address: string;
  chainId: number;
  /** ERC-8004 identity on Monad testnet, when registered. */
  erc8004AgentId: string | null;
  mandate: PublicMandateDto;
  /** Whether the policy lets funds go home to the owner's wallet (the address is not shown). */
  returnsToOwner: boolean;
  /** ISO 8601: when the current mandate took effect. */
  mandateSince: string;
  mandateAnchor: PublicMandateAnchorDto | null;
  /** ISO 8601. */
  createdAt: string;
  revokedAt: string | null;
  /** The owner put it away (SEN-197). Its history still stands here. */
  archived: boolean;
  preset: { id: string; name: string; customized: boolean } | null;
  forkedFrom: string | null;
  /** How many agents were hired as a copy of this one. */
  copies: number;
  /** Only when the owner published it; `null` otherwise. */
  prompt: { systemPrompt: string; strategy: string } | null;
  /** The agent page's figures, from the same event-log summary. Quote units, decimal strings. */
  pnl: { allTime: string; last24h: string; allTimePartial: boolean };
  counts: { trades: number; held: number; theses: number };
  /** `null` when the wallet could not be read just now. */
  balance: { approxUsd: string; note: string } | null;
  fills: PublicFillDto[];
  refusals: PublicRefusalDto[];
  /** ISO 8601: the answer is cached, so this is also its age. */
  generatedAt: string;
}

/** Every top-level key the response may carry. The spec pins the response to exactly these. */
export const PUBLIC_AGENT_KEYS: readonly (keyof PublicAgentDto)[] = [
  'id',
  'name',
  'sigilSeed',
  'owner',
  'model',
  'status',
  'address',
  'chainId',
  'erc8004AgentId',
  'mandate',
  'returnsToOwner',
  'mandateSince',
  'mandateAnchor',
  'createdAt',
  'revokedAt',
  'archived',
  'preset',
  'forkedFrom',
  'copies',
  'prompt',
  'pnl',
  'counts',
  'balance',
  'fills',
  'refusals',
  'generatedAt',
];

/** Which agents have a public page. See the module comment for why it is all of them. */
export function isPublished(agent: AgentRecord | undefined): agent is AgentRecord {
  return agent !== undefined;
}

export function publicStatus(agent: AgentRecord, now: number): PublicAgentStatus {
  if (agent.status === 'revoked') return 'revoked';
  return agent.mandate.expiresAt * 1000 <= now ? 'expired' : 'active';
}

export interface PublicAgentInputs {
  agent: AgentRecord;
  owner: { name: string | null };
  summary: Omit<AgentEventSummary, 'lastEvent'>;
  fills: readonly AgentFillDto[];
  /** Refusal events, oldest first, as the log lists them. */
  refusals: readonly AgentEvent[];
  copies: number;
  balance: { approxUsd: string; note: string } | null;
  now: number;
}

export function toPublicAgent(input: PublicAgentInputs): PublicAgentDto {
  const { agent, summary, now } = input;
  const { returnTo, ...mandate } = toMandateDto(agent.mandate);
  const preset = agent.preset
    ? {
        id: agent.preset.id,
        name: getPreset(agent.preset.id)?.name ?? agent.preset.id,
        customized: agent.preset.customized,
      }
    : null;
  return {
    id: agent.id,
    name: agent.name,
    sigilSeed: agent.id,
    owner: { name: input.owner.name, avatarSeed: `owner/${agent.id}` },
    model: agent.model,
    status: publicStatus(agent, now),
    address: agent.address,
    chainId: agent.mandate.chainId,
    erc8004AgentId: agent.erc8004AgentId ?? null,
    mandate,
    returnsToOwner: returnTo !== undefined,
    mandateSince: (agent.mandateSince ?? agent.createdAt).toISOString(),
    mandateAnchor: anchorOf(agent),
    createdAt: agent.createdAt.toISOString(),
    revokedAt: agent.revokedAt ? agent.revokedAt.toISOString() : null,
    archived: agent.archivedAt !== undefined,
    preset,
    forkedFrom: agent.forkedFrom ?? null,
    copies: input.copies,
    prompt: agent.public ? { systemPrompt: agent.systemPrompt, strategy: agent.strategy } : null,
    pnl: {
      allTime: summary.pnl.allTime,
      last24h: summary.pnl.last24h,
      allTimePartial: summary.pnl.allTimePartial === true,
    },
    counts: { trades: summary.trades, held: summary.held, theses: summary.theses },
    balance: input.balance
      ? { approxUsd: input.balance.approxUsd, note: input.balance.note }
      : null,
    fills: input.fills.slice(0, PUBLIC_RECENT_LIMIT).map((fill) => ({
      venue: fill.venue,
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      txHash: fill.txHash,
      at: fill.at,
    })),
    refusals: input.refusals
      .slice(-PUBLIC_RECENT_LIMIT)
      .reverse()
      .map((event) => toPublicRefusal(event, [returnTo, agent.userId])),
    generatedAt: new Date(now).toISOString(),
  };
}

function toPublicRefusal(
  event: AgentEvent,
  ownerAddresses: readonly (string | undefined)[],
): PublicRefusalDto {
  const code = event.detail['code'];
  const message = event.detail['message'];
  return {
    layer: event.layer === 'enclave' ? 'enclave' : 'sente',
    code: typeof code === 'string' ? code.slice(0, 64) : null,
    message: typeof message === 'string' ? scrubMessage(message, ownerAddresses) : null,
    at: event.at,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A refusal message is written for the owner, so it may name their own wallets
 * (the return address, the signer that is their user id) or an internal id. Both come out; the rest is
 * the gate's sentence about the limit, which is the point of showing it.
 */
export function scrubMessage(
  message: string,
  ownerAddresses: readonly (string | undefined)[],
): string {
  let out = message;
  for (const address of ownerAddresses) {
    // An address is hex only, so it is safe as a pattern.
    if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
      out = out.replace(new RegExp(address, 'gi'), 'the owner’s wallet');
    }
  }
  out = out.replace(UUID, '…');
  return out.length > PUBLIC_REFUSAL_MESSAGE_MAX
    ? `${out.slice(0, PUBLIC_REFUSAL_MESSAGE_MAX - 1)}…`
    : out;
}

/** SEN-194's anchor: every field is already public (it is on chain). */
function anchorOf(agent: AgentRecord): PublicMandateAnchorDto | null {
  const anchor = agent.mandateAnchor;
  if (!anchor) return null;
  return {
    mandateHash: anchor.mandateHash,
    ...(anchor.policyHash ? { policyHash: anchor.policyHash } : {}),
    status: anchor.status,
    txHash: anchor.txHash,
    chainId: anchor.chainId,
    registry: anchor.registry,
    agentTokenId: anchor.agentTokenId,
    anchoredAt: anchor.anchoredAt,
  };
}
