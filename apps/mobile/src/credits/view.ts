/**
 * What the Credits screen says (SEN-183), as plain functions so
 * `view.test.ts` runs under node: the dollar figures, the row of stones the
 * free tier is drawn as, the reset line, and the plan and auto top-up copy.
 *
 * Model credits are small money: a run costs fractions of a cent, so a figure
 * under a cent keeps four places rather than rounding to `$0.00`.
 */
import type { CreditPlan, CreditsOverview, LimitReset } from './api.ts';

/** `$8.75`, `$0.30`, `$0.0042`, `$0`. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  const abs = Math.abs(usd);
  const places = abs < 0.01 ? 4 : 2;
  const fixed = abs.toFixed(places);
  const trimmed = abs >= 1 && fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
  return `${usd < 0 ? '−' : ''}$${trimmed}`;
}

/** The most stones the row draws; past it each stone stands for more than a dollar. */
export const MAX_STONES = 20;

export type StoneRow = {
  /** 0..1 per stone, left to right: how much of that stone is still unspent. */
  fills: number[];
  /** USD each stone stands for. */
  perStone: number;
};

/**
 * The free tier as stones: one per dollar of the limit (10 for the free tier),
 * the unspent ones white, the spent ones hollow, and the stone the meter is in
 * part-filled. A limit past `MAX_STONES` dollars is drawn in `MAX_STONES`.
 */
export function stoneRow(remainingUsd: number, limitUsd: number): StoneRow {
  if (!(limitUsd > 0)) return { fills: [], perStone: 0 };
  const count = Math.min(MAX_STONES, Math.max(1, Math.round(limitUsd)));
  const perStone = limitUsd / count;
  const left = Math.min(limitUsd, Math.max(0, remainingUsd)) / perStone;
  const fills = Array.from(
    { length: count },
    (_, i) => Math.round(Math.min(1, Math.max(0, left - i)) * 100) / 100,
  );
  return { fills, perStone };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Nov 1` from an ISO instant, read in UTC because that is when OpenRouter resets. */
export function utcDay(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

const PERIOD_WORD: Record<Exclude<LimitReset, null>, string> = {
  daily: 'every day',
  weekly: 'every Monday',
  monthly: 'on the 1st of each month',
};

/** `Refills to $10 on Nov 1 (00:00 UTC).` or `A one-off allowance — it doesn't refill.` */
export function resetLine(overview: Pick<CreditsOverview, 'reset' | 'limitUsd'>): string {
  const { period, resetsAt } = overview.reset;
  if (period === null) return 'A one-off allowance — it doesn’t refill.';
  const day = resetsAt ? utcDay(resetsAt) : null;
  const amount = overview.limitUsd !== null ? ` to ${formatUsd(overview.limitUsd)}` : '';
  return day
    ? `Refills${amount} on ${day} (00:00 UTC). Unused credit doesn’t carry over.`
    : `Refills${amount} ${PERIOD_WORD[period]}. Unused credit doesn’t carry over.`;
}

/** `10 USD of AI credits on us, every month` — the period said only when there is one. */
export function freeTierLine(freeTierUsd: number, period: LimitReset): string {
  const every =
    period === 'monthly'
      ? ', every month'
      : period === 'weekly'
        ? ', every week'
        : period === 'daily'
          ? ', every day'
          : '';
  return `You’re on the free tier — ${formatUsd(freeTierUsd).slice(1)} USD of AI credits on us${every}.`;
}

/** A plan card's headline and the line under it. */
export function planCard(
  plan: CreditPlan,
  custom: { minUsd: number; maxUsd: number },
): { title: string; detail: string } {
  if (plan.usd === null) {
    return {
      title: 'Custom',
      detail: `${formatUsd(custom.minUsd)}–${formatUsd(custom.maxUsd)}`,
    };
  }
  return { title: formatUsd(plan.usd), detail: 'of model credits' };
}

/** `When less than $2 is left, add $10.` */
export function autoTopUpLine(thresholdUsd: number, amountUsd: number): string {
  return `When less than ${formatUsd(thresholdUsd)} is left, add ${formatUsd(amountUsd)}.`;
}

/** `Paid in USDC or AUSD from your wallet.` */
export function paymentLine(assets: readonly string[]): string {
  if (assets.length === 0) return '';
  const names =
    assets.length === 1 ? assets[0] : `${assets.slice(0, -1).join(', ')} or ${assets.at(-1)}`;
  return `Paid in ${names} from your wallet.`;
}

/** A run's cost for its row: `$0.0042`, or `no cost reported`. */
export function runCost(costUsd: number | null): string {
  if (costUsd === null) return 'no cost reported';
  // A run costs cents: one more place than a balance, so two runs can be told apart.
  return costUsd >= 0.01 && costUsd < 1 ? `$${costUsd.toFixed(3)}` : formatUsd(costUsd);
}

/** `2 runs`, `1 run`. */
export function runsLabel(n: number): string {
  return `${n} run${n === 1 ? '' : 's'}`;
}

/**
 * The refusal reasons — from a run, the scheduler, or `/credits` itself —
 * that the Credits screen answers. A message carrying one links there.
 */
const CREDITS_REASONS = new Set(['credits_exhausted', 'credits_low']);

export function isCreditsReason(reason: string | undefined | null): boolean {
  return reason !== undefined && reason !== null && CREDITS_REASONS.has(reason);
}

/** Share of the limit spent, 0..1, for a screen reader. */
export function spentShare(overview: Pick<CreditsOverview, 'limitUsd' | 'remainingUsd'>): number {
  const { limitUsd, remainingUsd } = overview;
  if (limitUsd === null || limitUsd <= 0 || remainingUsd === null) return 0;
  return Math.min(1, Math.max(0, 1 - remainingUsd / limitUsd));
}
