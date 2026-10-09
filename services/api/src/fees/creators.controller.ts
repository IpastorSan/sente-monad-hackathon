import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { fromUnits } from '@sente/venues/kuru';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CREATOR_FEES, CREATOR_SHARE, type CreatorFeeLedger } from './creator-fees';

/** How many of the caller's records `GET /creators/me/fees` lists. */
export const RECENT_CREATOR_FEES = 50;

/** One asset's totals, as decimal strings in that asset. */
export interface CreatorFeeTotalsDto {
  asset: string;
  accrued: string;
  paid: string;
  owed: string;
}

export interface CreatorFeeEntryDto {
  kind: 'accrued' | 'payout';
  asset: string;
  /** The creator's share (accrued) or the transfer (payout), in `asset`. */
  amount: string;
  /** Accrued only: the whole Sente fee the fill paid, in `asset`. */
  fee?: string;
  /** Accrued only: the forked agent that traded, and the caller's agent it came from. */
  agentId?: string;
  sourceAgentId?: string;
  /** The fill's transaction, or the treasury's transfer. */
  txHash: string;
  /** ISO 8601. */
  at: string;
}

/** `GET /creators/me/fees`. */
export interface CreatorFeesDto {
  /** The creator's share of Sente's fee on a fork's Kuru fills: "0.3" of it (3 of 10 bps). */
  share: string;
  totals: CreatorFeeTotalsDto[];
  /** Newest first, at most {@link RECENT_CREATOR_FEES}. */
  recent: CreatorFeeEntryDto[];
}

/**
 * `GET /creators/me/fees` (SEN-184): what Sente owes the caller as the creator
 * of agents others forked — 3 of the 10 bps Sente charges on each of those
 * forks' Kuru fills — what it has paid, and the latest entries. Identity is
 * the session's, as everywhere: there is no way to read another creator's.
 * Perpl fills carry no Sente fee, so they never accrue anything here.
 */
@Controller('creators')
@UseGuards(SessionAuthGuard)
export class CreatorsController {
  constructor(
    @Inject(CREATOR_FEES) private readonly ledger: CreatorFeeLedger,
    private readonly auth: Auth,
  ) {}

  @Get('me/fees')
  fees(): CreatorFeesDto {
    const { userId } = this.auth.principal();
    return {
      share: String(Number(CREATOR_SHARE.numerator) / Number(CREATOR_SHARE.denominator)),
      totals: this.ledger.totals(userId).map((t) => ({
        asset: t.asset,
        accrued: fromUnits(t.accruedAtoms, t.decimals),
        paid: fromUnits(t.paidAtoms, t.decimals),
        owed: fromUnits(t.owedAtoms, t.decimals),
      })),
      recent: this.ledger.recent(userId, RECENT_CREATOR_FEES).map((r) => ({
        kind: r.kind,
        asset: r.asset,
        amount: fromUnits(r.amountAtoms, r.decimals),
        ...(r.kind === 'accrued'
          ? {
              fee: fromUnits(r.feeAtoms, r.decimals),
              agentId: r.agentId,
              sourceAgentId: r.sourceAgentId,
            }
          : {}),
        txHash: r.txHash,
        at: r.at.toISOString(),
      })),
    };
  }
}
