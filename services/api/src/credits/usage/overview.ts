/**
 * `GET /credits` (SEN-183): the user's standing on their OpenRouter key, how
 * it resets, and the estimated breakdown beside it. Built field by field —
 * nothing here can carry the key or its hash.
 */
import type { CreditStanding, CreditsView } from '../credits.service';
import type { LimitReset } from '../openrouter.client';
import type { CreditsUsage } from './usage';

/** Every user is on the free tier until purchases open. */
export type CreditTier = 'free';

export interface CreditsReset {
  /** OpenRouter's `limit_reset`: null means the limit never resets. */
  readonly period: LimitReset;
  readonly resetsAt: string | null;
  /** Unused credit never carries into the next window: OpenRouter resets usage, not the limit. */
  readonly rollover: false;
  readonly summary: string;
}

export interface CreditsOverview extends CreditsView {
  readonly tier: CreditTier;
  /** False until the first run (or `POST /credits/provision`) mints the user's key. */
  readonly provisioned: boolean;
  /** `shared`: a dev server where every user draws on one key; the numbers are everyone's. */
  readonly mode: 'per-user' | 'shared';
  /** What the free tier gives a new key, USD per window. */
  readonly freeTierUsd: number;
  /** Spent in this window by OpenRouter's meter; the same figure as `usageMonthUsd`. */
  readonly usedUsd: number;
  readonly reset: CreditsReset;
  readonly usage: CreditsUsage;
}

const RESET_SUMMARY: Record<Exclude<LimitReset, null>, string> = {
  daily: 'Resets to the full limit at 00:00 UTC every day.',
  weekly: 'Resets to the full limit at 00:00 UTC every Monday.',
  monthly: 'Resets to the full limit at 00:00 UTC on the 1st of each month.',
};

export function resetSummary(period: LimitReset): string {
  const base = period === null ? 'A one-off allowance: it does not reset.' : RESET_SUMMARY[period];
  return period === null ? base : `${base} Unused credit does not carry over.`;
}

export function creditsOverview(
  standing: CreditStanding,
  usage: CreditsUsage,
  freeTierUsd: number,
): CreditsOverview {
  const { view } = standing;
  return {
    limitUsd: view.limitUsd,
    remainingUsd: view.remainingUsd,
    usageMonthUsd: view.usageMonthUsd,
    resetsAt: view.resetsAt,
    tier: 'free',
    provisioned: standing.provisioned,
    mode: standing.mode,
    freeTierUsd,
    usedUsd: view.usageMonthUsd,
    reset: {
      period: standing.limitReset,
      resetsAt: view.resetsAt,
      rollover: false,
      summary: resetSummary(standing.limitReset),
    },
    usage,
  };
}
