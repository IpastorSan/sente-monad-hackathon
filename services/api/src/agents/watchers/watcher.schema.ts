/**
 * Watchers (SEN-182): conditions an agent leaves behind so Sente can check the
 * market for it between runs WITHOUT a model call, and wake it only when one
 * fires. This file is the shape and its validation, shared by the agent's
 * `set_watchers` tool and the owner's `PUT /agents/:id/watchers` routes, so
 * both are held to exactly the same rules.
 *
 * A watcher is up to four clauses joined by `all` or `any`:
 * - `price`: the market's last or mark price against a number;
 * - `price_band`: the price inside, outside, entering or leaving [low, high];
 * - `indicator`: any `get_indicators` output on a timeframe against a number
 *   or against another output (MACD line crossing its signal);
 * - `position`: the agent's own Perpl position's unrealised P&L as a % of its
 *   margin, or the position opening or closing;
 * - `funding`: a Perpl perp's funding rate, % per 8 hours as `get_funding`
 *   reports it.
 *
 * `crosses_*`, `enters`, `leaves`, `opened` and `closed` are EDGES: true only
 * on the check where the condition flips, which needs the previous check's
 * answer kept between checks. The rest are LEVELS: true on every check while
 * they hold, so the cooldown is what stops one from waking the agent each tick.
 */
import * as z from 'zod/v4';

import { computeIndicator, labelOf, type IndicatorSpec } from '../tools/indicators';
import { indicatorSpec, KLINE_INTERVALS } from '../tools/indicator-schema';

export const MAX_WATCHERS = 8;
export const MAX_CLAUSES = 4;
export const DEFAULT_COOLDOWN_MINUTES = 60;
export const MAX_COOLDOWN_MINUTES = 1_440;
export const DEFAULT_HEARTBEAT_SECONDS = 4 * 3_600;
export const MIN_HEARTBEAT_HOURS = 1;
export const MAX_HEARTBEAT_HOURS = 24;

const venue = z.enum(['kuru', 'perpl']).describe('"kuru" spot or "perpl" perps.');
const market = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'a market symbol such as "MON-USDC" or "BTC-PERP"')
  .describe('One of your mandate markets.');
const level = z.number().finite();
const comparison = z.enum(['above', 'below', 'crosses_above', 'crosses_below']);
const priceSource = z
  .enum(['last', 'mark'])
  .default('mark')
  .describe('"mark" (default; the mid on Kuru) or "last" traded price.');
const timeframe = z.enum(KLINE_INTERVALS);
const output = z
  .string()
  .regex(/^[A-Za-z]{1,16}$/)
  .describe('The output to read, e.g. "line" or "signal" for macd; omit for one-value indicators.');

export const priceClause = z.strictObject({
  type: z.literal('price'),
  venue,
  market,
  source: priceSource,
  op: comparison,
  value: level.positive(),
});

export const bandClause = z.strictObject({
  type: z.literal('price_band'),
  venue,
  market,
  source: priceSource,
  op: z.enum(['inside', 'outside', 'enters', 'leaves']),
  low: level.positive(),
  high: level.positive(),
});

export const indicatorClause = z.strictObject({
  type: z.literal('indicator'),
  venue,
  market,
  timeframe,
  indicator: indicatorSpec,
  output: output.optional(),
  op: comparison,
  value: level.optional().describe('Compare to this number, or give compareTo instead.'),
  compareTo: z
    .strictObject({
      indicator: indicatorSpec
        .optional()
        .describe('Another indicator on the same market and timeframe; default the same one.'),
      output: output.optional(),
    })
    .optional()
    .describe('Compare to another output, e.g. {"output":"signal"} for the MACD signal line.'),
});

export const positionClause = z.strictObject({
  type: z.literal('position'),
  market: market.describe('Your Perpl market.'),
  op: z.enum(['pnl_above', 'pnl_below', 'opened', 'closed']),
  value: level
    .optional()
    .describe('pnl_above/pnl_below only: unrealised P&L as a % of the position margin.'),
});

export const fundingClause = z.strictObject({
  type: z.literal('funding'),
  market: market.describe('Your Perpl market.'),
  op: z.enum(['above', 'below']),
  value: level.describe('% per 8 hours, as get_funding reports ratePctPer8h; may be negative.'),
});

export const watcherClause = z.discriminatedUnion('type', [
  priceClause,
  bandClause,
  indicatorClause,
  positionClause,
  fundingClause,
]);

export const watcherId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,24}$/, 'letters, digits, _ and -, up to 24');

export const watcherInput = z.strictObject({
  id: watcherId
    .optional()
    .describe("Keep a watcher's id to keep its state and history when you set it again."),
  label: z.string().trim().min(1).max(120).describe('Why you want to be woken, in a few words.'),
  match: z.enum(['all', 'any']).default('all').describe('Every clause, or any one of them.'),
  clauses: z.array(watcherClause).min(1).max(MAX_CLAUSES),
  cooldownMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_COOLDOWN_MINUTES)
    .default(DEFAULT_COOLDOWN_MINUTES)
    .describe('After it fires, it cannot fire again for this long.'),
});

export const watcherSetInput = z.strictObject({
  watchers: z.array(watcherInput).max(MAX_WATCHERS),
  heartbeatHours: z
    .number()
    .min(MIN_HEARTBEAT_HOURS)
    .max(MAX_HEARTBEAT_HOURS)
    .optional()
    .describe('Wake anyway after this long without a run, to re-plan; default 4.'),
});

export type WatcherClause = z.output<typeof watcherClause>;
export type IndicatorClause = z.output<typeof indicatorClause>;
export type WatcherInput = z.input<typeof watcherInput>;
export type ParsedWatcher = z.output<typeof watcherInput>;
export type WatcherSetInput = z.output<typeof watcherSetInput>;

/** The clauses that fire on a flip, which is why each keeps the previous check's answer. */
export function isEdge(clause: WatcherClause): boolean {
  switch (clause.op) {
    case 'crosses_above':
    case 'crosses_below':
    case 'enters':
    case 'leaves':
    case 'opened':
    case 'closed':
      return true;
    default:
      return false;
  }
}

/** A rule a watcher broke. `code` is what the API and the tool report. */
export class WatcherInvalidError extends Error {
  readonly code: 'invalid_input' | 'market_not_allowed' | 'venue_not_allowed';

  constructor(code: WatcherInvalidError['code'], message: string) {
    super(message);
    this.name = 'WatcherInvalidError';
    this.code = code;
  }
}

/** What a watcher's markets are checked against: the mandate, by symbol. */
export type MandateScope = (venue: 'kuru' | 'perpl', market: string) => 'ok' | 'venue' | 'market';

/** The outputs an indicator has, in the names `get_indicators` shows. */
export function outputsOf(spec: IndicatorSpec): string[] {
  return Object.keys(computeIndicator(spec, []).outputs);
}

/** `value` when the indicator has one output; otherwise the named output, which must exist. */
function resolveOutput(spec: IndicatorSpec, name: string | undefined, where: string): string {
  const names = outputsOf(spec);
  if (name === undefined) {
    if (names.length === 1) return names[0]!;
    throw new WatcherInvalidError(
      'invalid_input',
      `${where}: ${labelOf(spec)} has several outputs; name one of ${names.join(', ')}`,
    );
  }
  if (!names.includes(name)) {
    throw new WatcherInvalidError(
      'invalid_input',
      `${where}: ${labelOf(spec)} has no output "${name}"; it has ${names.join(', ')}`,
    );
  }
  return name;
}

/**
 * The rules zod cannot state field by field, applied to a parsed watcher:
 * every market in the mandate, the operands an op needs and only those, and
 * indicator outputs that exist. Returns the watcher with indicator outputs
 * filled in, so evaluation never has to guess. Throws `WatcherInvalidError`.
 */
export function checkWatcher(watcher: ParsedWatcher, scope: MandateScope): ParsedWatcher {
  const clauses = watcher.clauses.map((clause, i) => {
    const where = `clause ${i + 1}`;
    const fail = (message: string) =>
      new WatcherInvalidError('invalid_input', `${where}: ${message}`);
    const clauseVenue = 'venue' in clause ? clause.venue : 'perpl';
    const verdict = scope(clauseVenue, clause.market);
    if (verdict === 'venue') {
      throw new WatcherInvalidError(
        'venue_not_allowed',
        `${where}: your mandate does not include ${clauseVenue}`,
      );
    }
    if (verdict === 'market') {
      throw new WatcherInvalidError(
        'market_not_allowed',
        `${where}: ${clause.market} on ${clauseVenue} is not in your mandate; watch only ` +
          'markets you may trade',
      );
    }
    switch (clause.type) {
      case 'price':
        return clause;
      case 'price_band':
        if (clause.low >= clause.high) throw fail('the band needs low < high');
        return clause;
      case 'indicator': {
        if (clause.venue === 'perpl' && clause.timeframe === '1w') {
          throw fail('Perpl has no 1w candles; use 1d or shorter');
        }
        for (const spec of [clause.indicator, clause.compareTo?.indicator]) {
          if (spec?.type === 'macd' && spec.fast >= spec.slow) {
            throw fail(`macd needs fast < slow; got fast ${spec.fast}, slow ${spec.slow}`);
          }
        }
        if ((clause.value === undefined) === (clause.compareTo === undefined)) {
          throw fail('give exactly one of value (a number) or compareTo (another output)');
        }
        const outputName = resolveOutput(clause.indicator, clause.output, where);
        if (!clause.compareTo) return { ...clause, output: outputName };
        const otherSpec = clause.compareTo.indicator ?? clause.indicator;
        const otherOutput = resolveOutput(otherSpec, clause.compareTo.output, where);
        if (labelOf(otherSpec) === labelOf(clause.indicator) && otherOutput === outputName) {
          throw fail('an output compared with itself never crosses');
        }
        return {
          ...clause,
          output: outputName,
          compareTo: { indicator: otherSpec, output: otherOutput },
        };
      }
      case 'position':
        if (
          (clause.op === 'pnl_above' || clause.op === 'pnl_below') !==
          (clause.value !== undefined)
        ) {
          throw fail('pnl_above and pnl_below need a value (a %); opened and closed take none');
        }
        return clause;
      case 'funding':
        return clause;
    }
  });
  return { ...watcher, clauses };
}

/** Rejects two watchers with one id. */
export function checkUniqueIds(watchers: readonly { id?: string | undefined }[]): void {
  const seen = new Set<string>();
  for (const { id } of watchers) {
    if (id === undefined) continue;
    if (seen.has(id)) {
      throw new WatcherInvalidError('invalid_input', `two watchers share the id "${id}"`);
    }
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// Plain English, for `list_watchers` and the wake message.

/** A number short enough to read: six significant digits (at least two places), no exponent. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  const digits = abs === 0 ? 0 : Math.max(2, 5 - Math.floor(Math.log10(abs)));
  const fixed = value.toFixed(Math.min(digits, 10));
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

const WORDS: Record<string, string> = {
  above: 'is above',
  below: 'is below',
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
};

/** One clause, as a sentence fragment: "BTC-PERP mark crosses above 100000". */
export function describeClause(clause: WatcherClause): string {
  switch (clause.type) {
    case 'price':
      return `${clause.market} ${clause.source} ${WORDS[clause.op]} ${formatNumber(clause.value)}`;
    case 'price_band': {
      const band = `${formatNumber(clause.low)}–${formatNumber(clause.high)}`;
      const verb = {
        inside: 'is inside',
        outside: 'is outside',
        enters: 'enters',
        leaves: 'leaves',
      };
      return `${clause.market} ${clause.source} ${verb[clause.op]} ${band}`;
    }
    case 'indicator': {
      const left = operandLabel(clause.indicator, clause.output);
      const right = clause.compareTo
        ? operandLabel(clause.compareTo.indicator ?? clause.indicator, clause.compareTo.output)
        : formatNumber(clause.value ?? NaN);
      return `${clause.market} ${clause.timeframe} ${left} ${WORDS[clause.op]} ${right}`;
    }
    case 'position':
      return clause.op === 'opened' || clause.op === 'closed'
        ? `your ${clause.market} position is ${clause.op}`
        : `your ${clause.market} P&L ${clause.op === 'pnl_above' ? 'is above' : 'is below'} ` +
            `${formatNumber(clause.value ?? NaN)}% of margin`;
    case 'funding':
      return `${clause.market} funding ${WORDS[clause.op]} ${formatNumber(clause.value)}%/8h`;
  }
}

export function describeWatcher(watcher: {
  match: 'all' | 'any';
  clauses: readonly WatcherClause[];
}): string {
  return watcher.clauses.map(describeClause).join(watcher.match === 'all' ? ' and ' : ' or ');
}

/** `macd(12,26,9).line`, or just `rsi(14)` for a one-value indicator. */
export function operandLabel(spec: IndicatorSpec, output: string | undefined): string {
  return output === undefined || output === 'value' ? labelOf(spec) : `${labelOf(spec)}.${output}`;
}
