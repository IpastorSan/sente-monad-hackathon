import { MANDATE_CHAIN_ID, type Mandate } from '@sente/mandate';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  /** Atoms as decimal strings, never JS numbers — the form `parseMandate` accepts. */
  @IsObject()
  mandate!: Record<string, unknown>;
}

export class AmendMandateDto {
  @IsObject()
  mandate!: Record<string, unknown>;
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
   * keeps just its hash, so it cannot be shown again.
   */
  mcpToken: string;
}

export interface AgentListResponseDto {
  agents: AgentResponseDto[];
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
