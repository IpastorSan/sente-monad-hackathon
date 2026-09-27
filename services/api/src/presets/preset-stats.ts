/**
 * A preset's cohort stats (SEN-76, plan B-T16b), as a pure function of the
 * agents hired from it and their event logs. `GET /presets/:id/stats` loads
 * those and caches the answer; everything that decides a number is here.
 *
 * The stats sit on a card that sells the preset, so every choice below leans
 * towards NOT flattering it:
 *
 * - The cohort includes revoked agents that were active in the window. Only
 *   counting the survivors would drop the ones stopped after losing.
 * - Customised agents are counted (and the count is reported): leaving them
 *   out would let an owner's edit hide a loss the preset's text made.
 * - An agent that settled nothing in the window counts with a P&L of 0, not
 *   as missing: idling is an outcome too.
 * - Medians are null below `minN` rather than a figure from two agents.
 * - An agent whose oldest events the log has dropped (SEN-129) is left out of
 *   a median it could be wrong in, and a note says how many: dropped deposits
 *   shrink its capital and so INFLATE its return, and dropped verdicts inside
 *   the window would misstate its P&L. Left out, not counted as 0 — 0 would be
 *   a number the log cannot vouch for either.
 * - Money stays exact decimal strings (BigInt with a scale). The one division,
 *   the return, is kept as an exact fraction until the median is picked and
 *   then FLOORED, so rounding can only ever make it look worse, never better.
 */
import {
  NOT_TRUNCATED,
  type AgentEvent,
  type AgentEventTruncation,
} from '../agents/events/agent-event-log';
import { summariseEvents } from '../agents/events/summary';
import {
  addScaled,
  decimalOf,
  decimalString,
  PERPL_PNL_ASSET,
  type Scaled,
} from '../agents/events/verdict';
import type { AgentRecord } from '../agents/store/agent-store';

export const PRESET_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const PRESET_STATS_MIN_N = 5;
/** Decimal places the median return is floored to: 0.000001 of capital. */
export const RETURN_SCALE = 6;

/**
 * The stables a deposit counts as capital in: the same USDC + AUSD pair
 * `events/summary.ts` sums P&L in, so the return divides like by like. A MON
 * gas drip, or any other token, is not capital the agent trades with.
 */
const CAPITAL_ASSETS: ReadonlySet<string> = new Set(['USDC', PERPL_PNL_ASSET]);

/** The wire contract's `PresetStatsDto` (plan-backend.md, "Wire contract → Presets"). */
export interface PresetStatsDto {
  presetId: string;
  window: '30d';
  /** Active agents on the preset right now, whenever they were hired. */
  running: number;
  /** Agents in the cohort: on the preset and active at any point in the window. */
  n: number;
  minN: typeof PRESET_STATS_MIN_N;
  /**
   * ≈ $ (USDC + AUSD); null when fewer than `minN` agents have a whole window
   * in the log (`n` less any whose window was truncated — SEN-129).
   */
  medianPnl30d: string | null;
  /** A fraction (0.05 = +5 %), floored; null when `returnN < minN`. */
  medianReturn30d: string | null;
  /**
   * Cohort agents with deposited capital > 0 and their whole history in the
   * log: the return's sample.
   */
  returnN: number;
  /** Cohort agents whose text differs from the preset's render. */
  customized: number;
  definition: string;
  notes: string[];
  /** Epoch ms the figures were computed at. */
  asOf: number;
}

export type CohortRecord = Pick<
  AgentRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'revokedAt' | 'preset'
>;

export const PRESET_STATS_DEFINITION =
  'Cohort: agents hired from this preset that were active at any point in the last 30 days, ' +
  'revoked ones and customised ones included. P&L: realised P&L of the theses settled in the ' +
  'window, USDC and AUSD added as dollars; an agent that settled nothing counts as 0. ' +
  'Return: that P&L ÷ the USDC and AUSD deposited to the agent up to now, as a fraction ' +
  '(0.05 = 5%), floored, over the agents with deposits only (returnN). Medians are shown ' +
  `from ${PRESET_STATS_MIN_N} agents. Agents whose oldest events the server no longer holds are ` +
  'left out of the medians their missing events could change.';

/**
 * When the agent stopped, if it has. A revoked record should carry
 * `revokedAt`; one that somehow does not is taken to have stopped at its last
 * update, which is no later than the revoke — the conservative end.
 */
function stoppedAt(agent: CohortRecord): number | undefined {
  if (agent.revokedAt) return agent.revokedAt.getTime();
  return agent.status === 'revoked' ? agent.updatedAt.getTime() : undefined;
}

/** Whether the agent was active at any point in `[now - window, now]`. */
export function activeInWindow(agent: CohortRecord, now: number): boolean {
  if (agent.createdAt.getTime() > now) return false;
  const stopped = stoppedAt(agent);
  return stopped === undefined || stopped >= now - PRESET_STATS_WINDOW_MS;
}

/** Realised P&L of the verdicts settled in the window, via the card's own summing rule. */
export function windowPnl(events: readonly AgentEvent[], now: number): Scaled {
  const since = now - PRESET_STATS_WINDOW_MS;
  const inWindow = events.filter((e) => e.kind === 'verdict' && e.at >= since && e.at <= now);
  // `summariseEvents` owns which verdicts count (USDC + AUSD, decimal
  // `realisedPnl`); over window-filtered events its `allTime` IS the window.
  // Whether the window is whole is `presetStats`'s check, so none is passed here.
  return decimalOf(summariseEvents(inWindow, now, NOT_TRUNCATED).pnl.allTime)!;
}

/**
 * The stable capital deposited up to `now`. Deposits from before the window
 * count: that money was still funding the agent during it. Withdrawals are not
 * recorded anywhere, so they are not subtracted — that can only overstate the
 * capital, which understates the return.
 */
export function depositedCapital(events: readonly AgentEvent[], now: number): Scaled {
  let capital: Scaled = { units: 0n, scale: 0 };
  for (const event of events) {
    if (event.kind !== 'deposit' || event.at > now) continue;
    const asset = event.detail['asset'];
    if (typeof asset !== 'string' || !CAPITAL_ASSETS.has(asset)) continue;
    // Alchemy's `value` can arrive in exponent form ("1e-7"); `decimalOf`
    // refuses that, so such a deposit is left out rather than guessed at.
    const amount = decimalOf(event.detail['amount']);
    if (amount && amount.units > 0n) capital = addScaled(capital, amount);
  }
  return capital;
}

function compareScaled(a: Scaled, b: Scaled): number {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * 10n ** BigInt(scale - a.scale);
  const right = b.units * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The exact median; an even count averages the middle two (÷ 2 is exact: × 5, one more place). */
export function medianScaled(values: readonly Scaled[]): Scaled | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort(compareScaled);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  const sum = addScaled(sorted[mid - 1]!, sorted[mid]!);
  return { units: sum.units * 5n, scale: sum.scale + 1 };
}

/** An exact fraction `num / den` with `den > 0`. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export function ratioOf(numerator: Scaled, denominator: Scaled): Ratio {
  // (n / 10^ns) / (d / 10^ds) = (n · 10^ds) / (d · 10^ns)
  const num = numerator.units * 10n ** BigInt(denominator.scale);
  const den = denominator.units * 10n ** BigInt(numerator.scale);
  return den < 0n ? { num: -num, den: -den } : { num, den };
}

function compareRatio(a: Ratio, b: Ratio): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function medianRatio(values: readonly Ratio[]): Ratio | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort(compareRatio);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  const a = sorted[mid - 1]!;
  const b = sorted[mid]!;
  return { num: a.num * b.den + b.num * a.den, den: 2n * a.den * b.den };
}

/** The fraction as a decimal floored to `scale` places: towards −∞, so never above the truth. */
export function floorRatio(value: Ratio, scale: number): string {
  const scaledNum = value.num * 10n ** BigInt(scale);
  let units = scaledNum / value.den; // BigInt division truncates towards zero
  if (scaledNum % value.den !== 0n && scaledNum < 0n) units -= 1n;
  return decimalString({ units, scale });
}

export interface PresetStatsInput {
  presetId: string;
  /** Every agent on the preset, revoked included (`AgentStore.listAll`). */
  agents: readonly CohortRecord[];
  /** Events of the cohort agents, by agent id: at least their verdicts and deposits. */
  events: ReadonlyMap<string, readonly AgentEvent[]>;
  /**
   * The log's `truncation` of each cohort agent (SEN-129); a missing entry is
   * an agent the log dropped nothing of.
   */
  truncation: ReadonlyMap<string, AgentEventTruncation>;
  now: number;
}

export function presetStats(input: PresetStatsInput): PresetStatsDto {
  const { presetId, now } = input;
  const onPreset = input.agents.filter((a) => a.preset?.id === presetId);
  const running = onPreset.filter((a) => a.status === 'active').length;
  const cohort = onPreset.filter((a) => activeInWindow(a, now));

  const pnls: Scaled[] = [];
  const returns: Ratio[] = [];
  let customized = 0;
  let truncated = 0;
  for (const agent of cohort) {
    if (agent.preset?.customized) customized += 1;
    const events = input.events.get(agent.id) ?? [];
    const truncation = input.truncation.get(agent.id) ?? NOT_TRUNCATED;
    if (truncation.evicted > 0) truncated += 1;
    // Eviction is oldest-first, so the window's verdicts are all there when
    // the newest dropped event is older than the window.
    if (!windowIntact(truncation, now - PRESET_STATS_WINDOW_MS)) continue;
    const pnl = windowPnl(events, now);
    pnls.push(pnl);
    // Capital sums EVERY deposit ever, so any eviction makes it a lower bound.
    if (truncation.evicted > 0) continue;
    const capital = depositedCapital(events, now);
    if (capital.units > 0n) returns.push(ratioOf(pnl, capital));
  }

  const n = cohort.length;
  const returnN = returns.length;
  const medianPnl = pnls.length >= PRESET_STATS_MIN_N ? medianScaled(pnls) : undefined;
  const medianReturn = returnN >= PRESET_STATS_MIN_N ? medianRatio(returns) : undefined;

  return {
    presetId,
    window: '30d',
    running,
    n,
    minN: PRESET_STATS_MIN_N,
    medianPnl30d: medianPnl ? decimalString(medianPnl) : null,
    medianReturn30d: medianReturn ? floorRatio(medianReturn, RETURN_SCALE) : null,
    returnN,
    customized,
    definition: PRESET_STATS_DEFINITION,
    notes: notesFor({ n, pnlN: pnls.length, returnN, customized, truncated }),
    asOf: now,
  };
}

/** Whether every event at or after `since` is still in the log. */
function windowIntact(truncation: AgentEventTruncation, since: number): boolean {
  if (truncation.evicted === 0) return true;
  return truncation.newestEvictedAt !== null && truncation.newestEvictedAt < since;
}

function notesFor(s: {
  n: number;
  pnlN: number;
  returnN: number;
  customized: number;
  truncated: number;
}): string[] {
  const notes = ['P&L adds USDC and AUSD as dollars (≈ $); they are different tokens.'];
  if (s.truncated > 0) {
    notes.push(
      `The server no longer holds the oldest events of ${s.truncated} of ${s.n} agents; ` +
        `${s.n - s.pnlN} are left out of the median P&L and all ${s.truncated} of the median return.`,
    );
  }
  if (s.n < PRESET_STATS_MIN_N) {
    notes.push(
      `Too new to rate: ${s.n} agent${s.n === 1 ? '' : 's'} in the window, ` +
        `medians need ${PRESET_STATS_MIN_N}.`,
    );
  } else if (s.pnlN < PRESET_STATS_MIN_N) {
    notes.push(
      `Only ${s.pnlN} of ${s.n} agents have their whole window on record, ` +
        'so there is no median yet.',
    );
  } else if (s.returnN < PRESET_STATS_MIN_N) {
    notes.push(
      `Only ${s.returnN} of ${s.n} agents have recorded deposits, so there is no median return yet.`,
    );
  }
  if (s.customized > 0) {
    notes.push(
      `${s.customized} of ${s.n} agents run edited text; they are counted, ` +
        'so these results are not the preset’s alone.',
    );
  }
  return notes;
}
