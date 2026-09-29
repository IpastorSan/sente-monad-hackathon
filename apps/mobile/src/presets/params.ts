/**
 * Configuring a preset before hiring it (SEN-116, plan U-9; agents.html →
 * "Hire Range Trader"). Pure, so `params.test.ts` pins it without a device.
 *
 * Four jobs:
 *
 * - `controlFor`: a `ParamSpec` becomes the control that edits it — number →
 *   slider, segmented or amount field; enum → segmented or chips; boolean →
 *   toggle; market → chips.
 * - `checkParams`: validation is `resolveParams` itself, the gate the API runs
 *   on hire (B-T15), so the phone can never pass what the server refuses or
 *   refuse what it accepts.
 * - Honesty: every price level says whether it rests on the venue as a real
 *   order or is only watched by the agent between runs, and the read-back
 *   sentence says it again in the agent's voice. Soft rules are labelled as
 *   the agent's own, never the mandate's.
 * - The mandate step's starting form, from the preset's suggested mandate,
 *   through the same `MandateForm` a person edits — so the mandate sent is
 *   still `mandateToSend`'s, byte for byte.
 */
import {
  KURU_SPOT_MARKETS,
  formatNumber,
  getPreset,
  marketAssets,
  resolveParams,
  type MarketParamSpec,
  type ParamSpec,
  type ParamValue,
  type Params,
  type PresetDefinition,
  type SuggestedMandate,
} from '@sente/presets';
import type { Address } from 'viem';

import type { AgentMandate, HireAgentRequest } from '../agents/api.ts';
import { KURU_MARKETS, type MandateForm } from '../agents/mandate.ts';
import { presetValues, type PresetId as TierId, type PresetValues } from '../agents/presets.ts';

const DAY_SECONDS = 86_400;

// ─── Honesty: real orders vs agent-watched levels ──────────────────────────

/**
 * `resting`: a real limit order on the venue, which fills at its price even
 * between runs. `watched`: a level the agent checks when it runs; price can
 * pass through it between runs and the exit fills wherever price is then.
 */
export type LevelKind = 'resting' | 'watched';

/**
 * Per preset, which parameters are price levels and what kind. Read off each
 * preset's render text (packages/presets/src/presets/*): Kuru has no stop
 * orders, so every stop is watched; only Range Trader's target and Mean
 * Reverter's take-profit rest on the venue. DCA Stacker sets no stops at all.
 */
const LEVELS: Readonly<Record<string, Readonly<Record<string, LevelKind>>>> = {
  'range-trader': { target: 'resting', stop: 'watched' },
  guardian: { sellAbove: 'watched', sellBelow: 'watched' },
  'trend-rider': { trailingStop: 'watched' },
  'mean-reverter': { takeBack: 'resting', stop: 'watched' },
  // The liquidation guard is not a parameter, but "close when funding flips"
  // is an exit the agent checks each run, never an order.
  'funding-harvester': { exitOnFlip: 'watched' },
  'dca-stacker': {},
};

export function levelKind(presetId: string, key: string): LevelKind | undefined {
  return LEVELS[presetId]?.[key];
}

export const LEVEL_TAG: Record<LevelKind, string> = {
  resting: 'real order',
  watched: 'agent-watched',
};

export const LEVEL_NOTE: Record<LevelKind, string> = {
  resting: 'rests on the venue as a limit order',
  watched: 'checked every run, not a venue order',
};

/** How a suggested-mandate soft rule is labelled wherever it is shown. */
export const SOFT_RULE_NOTE = 'The agent follows this; the mandate can’t enforce it.';

/**
 * Things a preset cannot do, beyond what its levels say. Plain statements of
 * the strategy's failure mode, as the study's "What it can't do" asks.
 */
const CANT: Readonly<Record<string, readonly string[]>> = {
  'range-trader': [
    'Stop you out on the venue. Kuru has no stop orders, so it checks your stop when it runs and can sell past it.',
    'Tell a range from the start of a trend. When ranges break, it loses.',
    'Buy without price history. Until a candles read exists, it waits.',
  ],
  guardian: [
    'Sell at your exact line. Both lines are checked when it runs, not placed on Kuru, so a fast move can fill past them.',
    'Guard coins it doesn’t hold. Only what you hand it is guarded; your own wallet stays yours.',
  ],
  'trend-rider': [
    'Trail its stop on the venue. The trailing stop is checked when it runs, so a fast move can close past it.',
    'Outrun liquidation. With leverage, a sharp move can liquidate the position before its next run.',
    'Enter without price history. Until a candles read exists, it waits.',
  ],
  'funding-harvester': [
    'Open anything yet. No agent tool reports the funding rate today, so until one does it opens nothing.',
    'Guard against liquidation on the venue. Its liquidation guard is checked when it runs, not placed.',
    'Tie the two legs together. The hedge is its rule; the mandate can’t make the legs match.',
  ],
  'dca-stacker': [
    'Sell, or stop a loss. It only buys, and sets no stops.',
    'Time the market. It buys the same amount whatever the price.',
  ],
  'mean-reverter': [
    'Stop you out on the venue. The stop is checked when it runs and can fill past it.',
    'Tell a stretch from a new trend. When a move keeps going, it loses.',
    'Enter without price history. Until a candles read exists, it waits.',
  ],
};

export function cantDo(presetId: string): string[] {
  return [...(CANT[presetId] ?? []), 'Step outside the mandate, however it is prompted.'];
}

// ─── Controls ───────────────────────────────────────────────────────────────

type ControlBase = {
  key: string;
  label: string;
  help: string | undefined;
  level: LevelKind | undefined;
};

export type ParamControl = ControlBase &
  (
    | { kind: 'segmented' | 'chips'; options: { value: string; label: string }[] }
    | { kind: 'slider'; min: number; max: number; step: number; unit: string | undefined }
    | { kind: 'amount'; unit: string | undefined }
    | { kind: 'toggle' }
    | { kind: 'market'; options: string[]; multiple: boolean }
  );

/** Up to this many values, a number is a row of segments rather than a slider. */
const SEGMENTED_MAX = 5;
/** Past this many steps a slider can't land on a value by thumb: type it. */
const SLIDER_MAX_STEPS = 400;
/** Enums with more options than fit one segmented row become chips. */
const ENUM_SEGMENTED_MAX = 4;

/** Perp markets offered when `/markets` has not answered: the ones every preset names. */
const FALLBACK_PERPS = ['BTC-PERP', 'ETH-PERP'];
const PERP_SYMBOL = /^[A-Za-z0-9]{1,16}-PERP$/;

function stepCount(min: number, max: number, step: number): number {
  return Math.round((max - min) / step);
}

/** The values a number spec allows, for a segmented row. */
function numberValues(min: number, max: number, step: number): number[] {
  const count = stepCount(min, max, step);
  return Array.from({ length: count + 1 }, (_, i) => Number((min + i * step).toFixed(8)));
}

/**
 * Markets a market param may pick. Kuru's are fixed; Perpl lists its own at
 * runtime, so `perps` is what `/markets` served, or a fallback until it has.
 */
export function marketOptions(spec: MarketParamSpec, perps: readonly string[] = []): string[] {
  const served = perps.filter((symbol) => PERP_SYMBOL.test(symbol));
  const perpl = served.length > 0 ? served : FALLBACK_PERPS;
  const options =
    spec.venue === 'kuru'
      ? [...KURU_SPOT_MARKETS]
      : spec.venue === 'perpl'
        ? [...perpl]
        : [...KURU_SPOT_MARKETS, ...perpl];
  // The default is always offered, even when a served list leaves it out.
  for (const value of Array.isArray(spec.default) ? spec.default : [spec.default]) {
    if (!options.includes(value)) options.push(value);
  }
  return options;
}

export function controlFor(
  spec: ParamSpec,
  presetId: string,
  perps: readonly string[] = [],
): ParamControl {
  const base: ControlBase = {
    key: spec.key,
    label: spec.label,
    help: spec.help,
    level: levelKind(presetId, spec.key),
  };
  switch (spec.type) {
    case 'number': {
      const steps = stepCount(spec.min, spec.max, spec.step);
      if (steps + 1 <= SEGMENTED_MAX) {
        return {
          ...base,
          kind: 'segmented',
          options: numberValues(spec.min, spec.max, spec.step).map((value) => ({
            value: String(value),
            label: formatParam(spec, value),
          })),
        };
      }
      if (steps <= SLIDER_MAX_STEPS) {
        return {
          ...base,
          kind: 'slider',
          min: spec.min,
          max: spec.max,
          step: spec.step,
          unit: spec.unit,
        };
      }
      return { ...base, kind: 'amount', unit: spec.unit };
    }
    case 'enum':
      return {
        ...base,
        kind: spec.options.length <= ENUM_SEGMENTED_MAX ? 'segmented' : 'chips',
        options: spec.options.map((option) => ({ ...option })),
      };
    case 'boolean':
      return { ...base, kind: 'toggle' };
    case 'market':
      return {
        ...base,
        kind: 'market',
        options: marketOptions(spec, perps),
        multiple: spec.multiple,
      };
  }
}

/** A value as its control shows it: `1.5%`, `2x`, `10 USDC`, `3 days`. */
export function formatParam(spec: ParamSpec, value: unknown): string {
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const n = formatNumber(value);
      if (spec.unit === '%') return `${n}%`;
      if (spec.unit === 'x') return `${n}x`;
      if (spec.unit === 'min') return `${n} min`;
      if (spec.unit === 'h') return `${n} h`;
      return spec.unit ? `${n} ${spec.unit}` : n;
    }
    case 'enum':
      return spec.options.find((option) => option.value === value)?.label ?? String(value);
    case 'boolean':
      return value === true ? 'On' : 'Off';
    case 'market':
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

/** Snaps a slider position to the spec's grid, as `resolveParams` counts steps. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return Number((min + Math.round((clamped - min) / step) * step).toFixed(8));
}

// ─── Draft and validation ───────────────────────────────────────────────────

/**
 * What the screen holds: every control's value, with amount fields as the
 * text typed. `rawParams` turns it into what `resolveParams` (and the API)
 * receive.
 */
export type Draft = Record<string, ParamValue>;

export function initialDraft(def: Pick<PresetDefinition, 'params'>): Draft {
  const draft: Draft = {};
  for (const spec of def.params) {
    const value = spec.default;
    draft[spec.key] = Array.isArray(value) ? [...value] : value;
  }
  return draft;
}

const DECIMAL_TEXT = /^\s*\d+(\.\d+)?\s*$/;

/**
 * The params as sent. Typed amounts become numbers only when they read as a
 * plain decimal; anything else is left a string, so `resolveParams` refuses
 * it with its own "must be a number" instead of this guessing.
 */
export function rawParams(def: Pick<PresetDefinition, 'params'>, draft: Draft): Params {
  const raw: Record<string, ParamValue> = {};
  for (const spec of def.params) {
    const value = draft[spec.key];
    if (value === undefined) continue;
    raw[spec.key] =
      spec.type === 'number' && typeof value === 'string' && DECIMAL_TEXT.test(value)
        ? Number(value)
        : value;
  }
  return raw;
}

export type ParamsCheck =
  { ok: true; params: Params } | { ok: false; errors: Record<string, string> };

/** `resolveParams`, with each message led by its control's label. */
export function checkParams(
  def: Pick<PresetDefinition, 'params' | 'validate'>,
  draft: Draft,
): ParamsCheck {
  const resolved = resolveParams(def, rawParams(def, draft));
  if (resolved.ok) return resolved;
  const errors: Record<string, string> = {};
  for (const error of resolved.errors) {
    const label = def.params.find((spec) => spec.key === error.key)?.label ?? error.key;
    errors[error.key] ??= `${label} ${error.message}.`;
  }
  return { ok: false, errors };
}

// ─── Read-back ──────────────────────────────────────────────────────────────

/** `Every 15 minutes`, `Every minute`, `Every hour`, `Every day`, `Every week`. */
export function cadencePhrase(seconds: number): string {
  if (seconds === 60) return 'Every minute';
  if (seconds === 3_600) return 'Every hour';
  if (seconds === DAY_SECONDS) return 'Every day';
  if (seconds === 7 * DAY_SECONDS) return 'Every week';
  if (seconds % DAY_SECONDS === 0) return `Every ${seconds / DAY_SECONDS} days`;
  if (seconds % 3_600 === 0) return `Every ${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

function n(p: Params, key: string): string {
  const value = p[key];
  return typeof value === 'number' ? formatNumber(value) : String(value);
}

function s(p: Params, key: string): string {
  return String(p[key]);
}

const WINDOW_LABEL: Record<string, string> = {
  '12h': '12-hour',
  '1d': '1-day',
  '3d': '3-day',
  '1w': '1-week',
};

/**
 * The parameters read back in the agent's voice, first person (agents.html,
 * "Configure · strategy"). A summary of the rendered text, which the detail
 * and review show in full — and it never calls a watched level a stop order.
 */
export function readBackParams(def: PresetDefinition, p: Params): string {
  const every = cadencePhrase(def.suggestedCadenceSeconds(p));
  const market = s(p, 'market');
  const { base } = marketAssets(market);
  switch (def.id) {
    case 'range-trader':
      return (
        `${every} I’ll look at ${base}’s ${WINDOW_LABEL[s(p, 'lookback')] ?? s(p, 'lookback')} range. ` +
        `Within ${n(p, 'entryBand')}% of the low I’ll buy with up to ${n(p, 'sizePct')}% of my budget, ` +
        `then sell ${n(p, 'target')}% higher with a limit order resting on Kuru, ` +
        `or ${n(p, 'stop')}% lower when I see it on a run.`
      );
    case 'guardian':
      return (
        `${every} I’ll check ${market}’s best bid. At or above ${n(p, 'sellAbove')} USDC, ` +
        `or at or below ${n(p, 'sellBelow')}, I’ll sell up to ${n(p, 'amount')} ${base} at market. ` +
        'I watch both lines; neither is an order on Kuru.'
      );
    case 'trend-rider': {
      const both = p['direction'] === 'both';
      return (
        `${every} I’ll watch ${market} for a break of its ` +
        `${WINDOW_LABEL[s(p, 'lookback')] ?? s(p, 'lookback')} ${both ? 'high or low' : 'high'}. ` +
        `I’ll go ${both ? 'with the break' : 'long'} at ${n(p, 'leverage')}x with up to ${n(p, 'sizePct')}% ` +
        `of my collateral, and close when price turns ${n(p, 'trailingStop')}% from its best, ` +
        'which I watch rather than place on Perpl.'
      );
    }
    case 'funding-harvester': {
      const hedge = p['hedge'] === true;
      const exit =
        p['exitOnFlip'] === true
          ? 'close when funding flips'
          : `close when shorts pay ${n(p, 'minFunding')}% or more`;
      return (
        `${every} I’ll read ${market}’s funding. When it pays shorts at least ${n(p, 'minFunding')}% ` +
        `per 8 hours I’ll short at ${n(p, 'leverage')}x` +
        `${hedge ? ` and hold the same ${base} on Kuru` : ', unhedged'}, and ${exit}. ` +
        'I can’t read funding yet, so until I can, I open nothing.'
      );
    }
    case 'dca-stacker': {
      const dip = p['doubleOnDip'] === true ? ', double after a 5% drop,' : '';
      return (
        `${every} I’ll buy ${n(p, 'amount')} USDC of ${base} at market${dip} ` +
        `until ${n(p, 'budget')} USDC is spent. I never sell, and I set no stops.`
      );
    }
    case 'mean-reverter':
      return (
        `${every} I’ll compare ${market} with its ${WINDOW_LABEL[s(p, 'window')] ?? s(p, 'window')} average. ` +
        `${n(p, 'stretch')}% away, I’ll take the other side with up to ${n(p, 'sizePct')}% of my budget, ` +
        `take profit with a resting limit once it takes back ${n(p, 'takeBack')}% of the move, ` +
        `and get out ${n(p, 'stop')}% against me when I see it on a run.`
      );
  }
}

/**
 * "How it decides": the numbered steps of the rendered strategy, verbatim.
 * Quoting the text the agent receives, rather than paraphrasing it, is what
 * keeps the detail page from promising more than the agent is told.
 */
export function decisionSteps(strategy: string): string[] {
  return strategy
    .split('\n')
    .map((line) => /^\d+\.\s+(.*)$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined);
}

// ─── Mandate prefill ────────────────────────────────────────────────────────

function marketAddresses(symbols: readonly string[]): Address[] {
  return KURU_MARKETS.filter((market) => symbols.includes(market.symbol)).map(
    (market) => market.address,
  );
}

/**
 * The mandate step's starting form: the suggested tier's form, narrowed to the
 * preset's own venues, markets and limits. It only fills `MandateForm`, so the
 * mandate still comes out of `mandateToSend` and a person could have typed it.
 * `returnTo` stays the caller's wallet, never the preset's choice (SEN-17).
 */
export function suggestedValues(
  suggested: SuggestedMandate,
  now: number,
  returnTo?: Address,
): PresetValues {
  const tier = presetValues(suggested.tier, now, returnTo);
  const kuru = suggested.venues.includes('kuru');
  const perpl = suggested.venues.includes('perpl');
  const form: MandateForm = {
    ...tier.form,
    kuru,
    perpl,
    kuruMarkets: marketAddresses(suggested.kuruMarkets),
    depositCaps: Object.fromEntries(suggested.depositCaps.map((cap) => [cap.asset, cap.amount])),
    perplCollateral: suggested.perplCollateral ?? (perpl ? tier.form.perplCollateral : ''),
    perplMarkets: suggested.perplMarkets.join(', '),
    maxLeverage:
      suggested.maxLeverage !== null ? formatNumber(suggested.maxLeverage) : tier.form.maxLeverage,
    maxOrderNotional: suggested.maxOrderNotional,
    expiresAt: now + suggested.expiryDays * DAY_SECONDS,
  };
  return { form, expiryDays: suggested.expiryDays };
}

/**
 * Another tier chip picked on a preset's mandate: that tier's limits, but the
 * preset's venues and markets stay (agents.html: "Changing a preset chip
 * keeps the market"). A deposit cap the tier sets for the same token is
 * used; any other keeps the suggestion's amount, since the tiers are sized in
 * USDC and a Guardian cap is counted in the coin it guards. The suggested
 * tier itself restores the suggestion exactly.
 */
export function tierValues(
  tier: TierId,
  suggested: SuggestedMandate,
  now: number,
  returnTo?: Address,
): PresetValues {
  const suggestion = suggestedValues(suggested, now, returnTo);
  if (tier === suggested.tier) return suggestion;
  const chosen = presetValues(tier, now, returnTo);
  const perpl = suggestion.form.perpl;
  return {
    form: {
      ...suggestion.form,
      depositCaps: Object.fromEntries(
        Object.entries(suggestion.form.depositCaps).map(([asset, amount]) => [
          asset,
          chosen.form.depositCaps[asset] ?? amount,
        ]),
      ),
      perplCollateral: perpl
        ? chosen.form.perplCollateral || suggestion.form.perplCollateral
        : suggestion.form.perplCollateral,
      maxLeverage: perpl ? chosen.form.maxLeverage : suggestion.form.maxLeverage,
      maxOrderNotional: chosen.form.maxOrderNotional,
      expiresAt: chosen.form.expiresAt,
    },
    expiryDays: chosen.expiryDays,
  };
}

// ─── Review ─────────────────────────────────────────────────────────────────

/**
 * Bounds the API puts on an agent's own cadence (SEN-67, `AGENT_SCHEDULE_*_SECONDS`).
 * A week since SEN-158, so a weekly DCA Stacker is hired with its schedule.
 */
export const SCHEDULE_MIN_SECONDS = 60;
export const SCHEDULE_MAX_SECONDS = 7 * DAY_SECONDS;

/**
 * The schedule a hire sends, or `null` when the cadence is outside what the
 * API accepts. Clamping it would make it run more or less often than the
 * person chose, so it is hired without one and the review says so.
 */
export function scheduleFor(seconds: number): { everySeconds: number } | null {
  return Number.isInteger(seconds) &&
    seconds >= SCHEDULE_MIN_SECONDS &&
    seconds <= SCHEDULE_MAX_SECONDS
    ? { everySeconds: seconds }
    : null;
}

/**
 * The `POST /agents` body the review sends. No strategy or prompt: the API
 * renders them from these params with the catalog version this phone
 * previewed, and refuses if it moved. The preset's cadence goes along as the
 * agent's schedule — pure so a spec can pin that a weekly DCA carries one
 * (SEN-158; SEN-116 hired it without).
 */
export function presetHireRequest(
  def: PresetDefinition,
  draft: Draft,
  params: Params,
  fields: { name: string; model: string; mandate: AgentMandate },
): HireAgentRequest {
  const schedule = scheduleFor(def.suggestedCadenceSeconds(params));
  return {
    name: fields.name.trim(),
    model: fields.model,
    mandate: fields.mandate,
    preset: { id: def.id, version: def.version, params: { ...rawParams(def, draft) } },
    ...(schedule ? { schedule } : {}),
  };
}

/** `96 runs a day`, `1 run a day`, `1 run a week`. */
export function runsLabel(seconds: number): string {
  if (seconds >= 7 * DAY_SECONDS) {
    const perWeek = Math.floor((7 * DAY_SECONDS) / seconds);
    return `${perWeek} run${perWeek === 1 ? '' : 's'} a week`;
  }
  const perDay = Math.floor(DAY_SECONDS / seconds);
  return `${perDay} run${perDay === 1 ? '' : 's'} a day`;
}

/** Prefilled agent names, one per preset; the person can change it. */
const NAMES: Readonly<Record<string, string>> = {
  'range-trader': 'Low Tide',
  guardian: 'Night Watch',
  'trend-rider': 'Tailwind',
  'funding-harvester': 'Slow Carry',
  'dca-stacker': 'Steady Stack',
  'mean-reverter': 'Snapback',
};

export function defaultAgentName(presetId: string, presetName: string): string {
  return NAMES[presetId] ?? presetName;
}

/**
 * What to fund the agent with: what it trades with. Guardian is handed the
 * coin it guards; a Kuru preset trades USDC; a Perpl one posts AUSD. With a
 * Kuru hedge beside a Perpl short, AUSD comes first — the short opens first —
 * and the review names the second token.
 */
export function fundingAssets(suggested: SuggestedMandate): string[] {
  const assets: string[] = [];
  if (suggested.venues.includes('perpl')) assets.push('AUSD');
  for (const cap of suggested.depositCaps) {
    if (!assets.includes(cap.asset)) assets.push(cap.asset);
  }
  if (assets.length === 0) assets.push('USDC');
  return assets;
}

/** A suggested amount to fund with, in the funding asset's units. */
export function suggestedFunding(
  presetId: string,
  params: Params,
  suggested: SuggestedMandate,
): string {
  const asset = fundingAssets(suggested)[0];
  if (presetId === 'guardian') return n(params, 'amount');
  if (presetId === 'dca-stacker') return n(params, 'budget');
  if (asset === 'AUSD' && suggested.perplCollateral !== null) return suggested.perplCollateral;
  return suggested.depositCaps.find((cap) => cap.asset === asset)?.amount ?? '';
}

// ─── Guardian ───────────────────────────────────────────────────────────────

/** How far from the live price Guardian's lines start: ±10%. */
const GUARDIAN_BAND = 0.1;
const GUARDIAN_STEP_DECIMALS = 6;

function roundSignificant(value: number, digits: number): number {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * The nearest value to `x`, at four significant figures, that `resolveParams`
 * accepts for `spec`. Nudged one unit of the last figure at a time because
 * the package's step check divides by 0.000001 in floating point and refuses
 * some plain values (2764, 12.5) as "not a multiple of 0.000001"; the server
 * runs the same check, so a prefill it would refuse is no prefill at all.
 * Above a few thousand almost nothing passes; then the plain rounded value is
 * returned and the field shows the package's own refusal rather than a line
 * moved further than four figures.
 */
function acceptedNear(spec: ParamSpec | undefined, x: number): number {
  const rounded = Math.max(1e-6, roundSignificant(x, 4));
  const unit = 10 ** (Math.floor(Math.log10(rounded)) - 3);
  for (let k = 0; k <= 10; k++) {
    for (const sign of k === 0 ? [1] : [1, -1]) {
      const candidate = Number((rounded + sign * k * unit).toFixed(GUARDIAN_STEP_DECIMALS));
      if (candidate <= 0) continue;
      if (!spec || resolveParams({ params: [spec] }, { [spec.key]: candidate }).ok) {
        return candidate;
      }
    }
  }
  return Number(rounded.toFixed(GUARDIAN_STEP_DECIMALS));
}

/**
 * Guardian's lines from the live price. Its catalog defaults (0.05 / 0.01)
 * are placeholders sized for MON; on any other coin — or MON at another price
 * — they would sell at once or never. So the lines start 10% either side of
 * the price, at four significant figures on the spec's 0.000001 grid.
 * `null` when the price is unusable: the placeholders then stand, and the
 * screen says so.
 */
export function guardianLines(
  price: string | number | null | undefined,
): { sellAbove: number; sellBelow: number } | null {
  const value = typeof price === 'string' ? Number(price) : price;
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const specs = getPreset('guardian')?.params ?? [];
  const spec = (key: string) => specs.find((candidate) => candidate.key === key);
  const sellAbove = acceptedNear(spec('sellAbove'), value * (1 + GUARDIAN_BAND));
  const sellBelow = acceptedNear(spec('sellBelow'), value * (1 - GUARDIAN_BAND));
  return sellBelow < sellAbove ? { sellAbove, sellBelow } : null;
}

/** The market a draft names, for the live price. */
export function draftMarket(draft: Draft): string | undefined {
  const market = draft['market'];
  return typeof market === 'string' ? market : undefined;
}
