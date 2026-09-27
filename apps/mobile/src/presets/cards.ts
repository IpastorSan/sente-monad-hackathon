/**
 * What a preset card says (SEN-114, plan U-8; agents.html → "Agents tab" and
 * "The catalog"). Pure, so `cards.test.ts` pins every line without a device.
 *
 * Three rules from the study:
 *
 * - Risk is three stones, not a colour. It is read off the preset's own
 *   suggested mandate tier (cautious / standard / wide), so the card can only
 *   claim as much risk as the limits it proposes allow.
 * - Every stat carries its sample ("30d · n=23"). A cohort below `minN` says
 *   "Too new to rate" instead of a median.
 * - Mint and berry belong to money that moved: the median return is the only
 *   coloured figure on a card.
 */
import type { MarketParamSpec, SuggestedMandate } from '@sente/presets';

import { amountLabel } from '../agents/leaderboard.ts';
import { formatPct, pctDirection, type Direction } from '../ui/tradingFormat.ts';

import type { PresetDto, PresetStatsDto } from './api.ts';

// ─── Risk ───────────────────────────────────────────────────────────────────

export type Risk = { stones: 1 | 2 | 3; label: 'Low' | 'Med' | 'High' };

const RISK: Record<SuggestedMandate['tier'], Risk> = {
  cautious: { stones: 1, label: 'Low' },
  standard: { stones: 2, label: 'Med' },
  wide: { stones: 3, label: 'High' },
};

export function riskOf(preset: PresetDto): Risk {
  return RISK[preset.defaults.suggestedMandate.tier];
}

// ─── Cadence ────────────────────────────────────────────────────────────────

/** `Every minute`, `5 min`, `1 hour`, `Daily`, `Weekly`: how often it checks by default. */
export function cadenceLabel(seconds: number): string {
  if (seconds === 60) return 'Every minute';
  if (seconds === 86_400) return 'Daily';
  if (seconds === 604_800) return 'Weekly';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds === 3_600) return '1 hour';
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

// ─── Where it trades ────────────────────────────────────────────────────────

function marketSpec(preset: PresetDto): MarketParamSpec | undefined {
  return preset.params.find((spec): spec is MarketParamSpec => spec.type === 'market');
}

/**
 * `Kuru spot`, `Perpl perps`, `Perpl + Kuru` (both legs at once), or
 * `Kuru or Perpl` when the market parameter picks the venue.
 */
export function venueLine(preset: PresetDto): string {
  if (marketSpec(preset)?.venue === 'any') return 'Kuru or Perpl';
  const names = preset.venues.map((venue) => (venue === 'kuru' ? 'Kuru' : 'Perpl'));
  if (names.length === 1) return names[0] === 'Kuru' ? 'Kuru spot' : 'Perpl perps';
  return names.join(' + ');
}

/**
 * The default market(s)' symbols, for the token stack. Only the defaults: a
 * card that listed every market a preset COULD trade would read as a promise.
 */
export function defaultMarkets(preset: PresetDto): string[] {
  const spec = marketSpec(preset);
  if (!spec) return [];
  const value = preset.defaults.params[spec.key] ?? spec.default;
  return (Array.isArray(value) ? value : [value]).filter((m): m is string => typeof m === 'string');
}

// ─── Filter chips ───────────────────────────────────────────────────────────

export type PresetFilter = 'all' | 'spot' | 'perps' | 'low';

export const PRESET_FILTERS: readonly { value: PresetFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'spot', label: 'Spot' },
  { value: 'perps', label: 'Perps' },
  { value: 'low', label: 'Low risk' },
];

/**
 * Spot and perps follow the market it trades, not every venue it touches:
 * Funding Harvester holds a Kuru hedge but its trade is the perp short.
 */
export function matchesFilter(preset: PresetDto, filter: PresetFilter): boolean {
  const venue = marketSpec(preset)?.venue;
  switch (filter) {
    case 'all':
      return true;
    case 'spot':
      return venue === undefined ? preset.venues.includes('kuru') : venue !== 'perpl';
    case 'perps':
      return venue === undefined ? preset.venues.includes('perpl') : venue !== 'kuru';
    case 'low':
      return riskOf(preset).stones === 1;
  }
}

// ─── Stats line ─────────────────────────────────────────────────────────────

export type StatsLine = {
  /** `23 running` */
  running: string;
  /**
   * The figure after it: a median (the one coloured number on the card), or
   * the reason there is none.
   */
  figure:
    | { kind: 'median'; value: string; direction: Direction }
    | { kind: 'too-new' }
    | { kind: 'none' };
  /** The sample the figure came from: `30d · n=23`. Always present. */
  sample: string;
};

/**
 * The card's cohort line, or `null` when there are no stats to show (route
 * absent, preset unknown to the server, request failed) — the card then drops
 * the line rather than printing zeros.
 *
 * The median return is preferred and printed over its own sample (`returnN`:
 * only agents with a known deposit count). Without it the median P&L stands
 * in, over the whole cohort `n`, as ≈ $ because it adds USDC and AUSD.
 */
export function statsLine(stats: PresetStatsDto | null | undefined): StatsLine | null {
  if (!stats) return null;
  const running = `${stats.running} running`;
  if (stats.n < stats.minN) {
    return { running, figure: { kind: 'too-new' }, sample: sample(stats.n) };
  }
  if (stats.medianReturn30d !== null) {
    const pct = Number(stats.medianReturn30d) * 100;
    if (Number.isFinite(pct)) {
      return {
        running,
        figure: { kind: 'median', value: formatPct(pct, 1), direction: pctDirection(pct, 1) },
        sample: sample(stats.returnN),
      };
    }
  }
  if (stats.medianPnl30d !== null) {
    const pnl = Number(stats.medianPnl30d);
    if (Number.isFinite(pnl)) {
      // The sign comes from the rounded cents, so "+$0.00" is never printed in mint.
      const cents = Math.round(pnl * 100);
      const direction: Direction = cents === 0 ? 'flat' : cents > 0 ? 'up' : 'down';
      const sign = direction === 'up' ? '+' : direction === 'down' ? '−' : '';
      return {
        running,
        figure: {
          kind: 'median',
          value: `≈ ${sign}$${amountLabel(stats.medianPnl30d)}`,
          direction,
        },
        sample: sample(stats.n),
      };
    }
  }
  return { running, figure: { kind: 'none' }, sample: sample(stats.n) };
}

function sample(n: number): string {
  return `30d · n=${n}`;
}

// ─── Featured ───────────────────────────────────────────────────────────────

/** The featured card's preset: Guardian, the honest answer to "where is my stop-loss?". */
export const FEATURED_PRESET_ID = 'guardian';

/**
 * The featured card's small print. Guardian is featured BECAUSE its stop is
 * honest, so the card says what kind of stop it is before anyone taps it:
 * lines checked every run, not orders resting on Kuru (which has none).
 */
export const FEATURED_NOTE =
  'Your lines are checked every run, not placed on the venue: a fast move can fill past them.';
