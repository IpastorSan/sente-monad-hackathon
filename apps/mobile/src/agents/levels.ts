/**
 * An agent's stop and target, and what KIND of level each one is (SEN-117).
 *
 * The one place that turns an agent's preset params into prices: the cockpit's
 * stop → target track and the live position screen both read it, so the two
 * can never disagree about where a level is or whether it exists.
 *
 * Every level is applied to the entry exactly the way the preset's own render
 * tells the agent to (`packages/presets/src/presets/*.ts`), and every level
 * says whether it is REAL or WATCHED — the difference the brief insists on:
 *
 * | Preset            | Target                     | Stop                          |
 * | ----------------- | -------------------------- | ----------------------------- |
 * | Range Trader      | resting limit sell (order) | % below entry, watched        |
 * | Mean Reverter     | resting limit (order)      | % against entry, watched      |
 * | Guardian          | sell-above line, watched   | sell-below line, watched      |
 * | Trend Rider       | none                       | trailing %, watched           |
 * | Funding Harvester | none                       | liquidation guard, watched    |
 * | DCA Stacker       | none                       | none                          |
 *
 * An agent with no preset, a preset this build does not know, or one whose
 * instructions were edited after the preset wrote them gets NO levels: its
 * thesis is the only honest account of what it will do.
 *
 * Pure: no React, no React Native, so `levels.test.ts` runs under plain node.
 */
import { getPreset } from '@sente/presets';

import type { AgentPresetRef } from './api.ts';

export type LevelRole = 'target' | 'stop';

/**
 * `order`: resting on the venue, fills without the agent looking.
 * `watched`: the agent checks it when it runs, so price can pass through it
 * between runs and the exit fills at whatever price the run sees.
 */
export type LevelSource = 'order' | 'watched';

export type AgentLevel = {
  role: LevelRole;
  /** Decimal string, at the entry's precision (at least 4 places). */
  price: string;
  source: LevelSource;
  /** How the preset names it: `target`, `stop`, `trailing stop`, `liquidation guard`. */
  name: string;
};

export type LevelInput = {
  entry: string;
  side: 'long' | 'short';
  /** Perpl's liquidation estimate: Funding Harvester's guard is measured from it. */
  liq?: string | null;
  /**
   * The best price since entry (highest for a long, lowest for a short), when
   * the screen has candles. Trend Rider trails its stop from it; without it
   * the stop is drawn from the entry, which is the loosest it can be.
   */
  extreme?: string | null;
};

type PresetInput = Pick<AgentPresetRef, 'id' | 'params'> & { customized?: boolean };

/**
 * Mirrors Funding Harvester's `LIQUIDATION_GUARD_PCT`: it closes the short when
 * the mark is within this many % of the liquidation price. Not exported by the
 * package, so a spec pins the number against the preset's own text.
 */
export const LIQUIDATION_GUARD_PCT = 10;

/** The preset's levels for one position, target first. Empty when it has none. */
export function presetLevels(
  preset: PresetInput | null | undefined,
  input: LevelInput,
): AgentLevel[] {
  // An edited preset runs on instructions the params no longer describe.
  if (!preset || preset.customized === true) return [];
  const entry = Number(input.entry);
  if (!Number.isFinite(entry) || entry <= 0) return [];
  const read = paramReader(preset);
  const places = Math.max(4, decimalsOf(input.entry));
  // +1 moves a price in the position's favour, −1 against it.
  const favour = input.side === 'long' ? 1 : -1;
  const at = (from: number, pct: number): string => (from * (1 + pct / 100)).toFixed(places);

  switch (preset.id) {
    case 'range-trader':
    case 'mean-reverter': {
      // Range Trader's target is a % of its own; Mean Reverter's is the
      // take-back share of the stretch (its `targetPct`).
      const target =
        preset.id === 'range-trader'
          ? read('target')
          : product(read('stretch'), read('takeBack'), 1 / 100);
      const stop = read('stop');
      if (target === null || stop === null) return [];
      return [
        { role: 'target', price: at(entry, favour * target), source: 'order', name: 'target' },
        { role: 'stop', price: at(entry, -favour * stop), source: 'watched', name: 'stop' },
      ];
    }
    case 'guardian': {
      const above = read('sellAbove');
      const below = read('sellBelow');
      if (above === null || below === null) return [];
      // Prices, not percents: the owner drew these lines, so they stay as written.
      return [
        { role: 'target', price: String(above), source: 'watched', name: 'sell above' },
        { role: 'stop', price: String(below), source: 'watched', name: 'sell below' },
      ];
    }
    case 'trend-rider': {
      const trail = read('trailingStop');
      if (trail === null) return [];
      // "The higher of your entry price and the lookback high": the best price
      // since entry stands in for the lookback high, which is where the stop
      // has ratcheted to while the position has been open.
      const extreme = Number(input.extreme);
      const from = Number.isFinite(extreme)
        ? favour > 0
          ? Math.max(entry, extreme)
          : Math.min(entry, extreme)
        : entry;
      return [
        {
          role: 'stop',
          price: at(from, -favour * trail),
          source: 'watched',
          name: 'trailing stop',
        },
      ];
    }
    case 'funding-harvester': {
      const liq = Number(input.liq);
      if (input.liq == null || !Number.isFinite(liq) || liq <= 0) return [];
      // "Within 10% of its liquidation price": the guard sits on the mark's
      // side of liquidation, below a short's liq and above a long's.
      return [
        {
          role: 'stop',
          price: at(liq, favour * LIQUIDATION_GUARD_PCT),
          source: 'watched',
          name: 'liquidation guard',
        },
      ];
    }
    default:
      // DCA Stacker never sells; anything unknown is not ours to guess.
      return [];
  }
}

/** Stop and target as a pair, for the stop → target track. `null` unless both exist. */
export type StopTarget = { stop: string; target: string };

export function stopAndTarget(levels: readonly AgentLevel[]): StopTarget | null {
  const stop = levels.find((level) => level.role === 'stop');
  const target = levels.find((level) => level.role === 'target');
  return stop && target ? { stop: stop.price, target: target.price } : null;
}

/** `TARGET · ORDER`, `TRAILING STOP · WATCHED`: the chart's label for a level. */
export function levelLabel(level: AgentLevel): string {
  return `${level.name} · ${level.source}`.toUpperCase();
}

/**
 * One sentence on what kind of levels these are, under the chart and on the
 * cockpit's track. `null` when there are none, because then there is nothing
 * to qualify.
 */
export function levelsNote(levels: readonly AgentLevel[], venue: 'kuru' | 'perpl'): string | null {
  if (levels.length === 0) return null;
  const venueName = venue === 'kuru' ? 'Kuru' : 'Perpl';
  const order = levels.filter((level) => level.source === 'order');
  const watched = levels.filter((level) => level.source === 'watched');
  const names = (list: readonly AgentLevel[]): string =>
    capitalise(list.map((level) => level.name).join(' and '));
  if (order.length === 0) {
    return `${names(watched)} ${watched.length === 1 ? 'is a level' : 'are levels'} the agent checks each run, not ${watched.length === 1 ? 'an order' : 'orders'} on ${venueName}.`;
  }
  if (watched.length === 0) return `${names(order)} rests on ${venueName} as a limit order.`;
  return `${names(order)} rests on ${venueName} as a limit order; ${names(watched).toLowerCase()} is checked each run, not an order.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Reads a numeric param leniently: numbers or numeric strings, falling back to
 * the catalog default when the key is absent (the server rendered the prompt
 * with that default). A value that is present but not a positive number means
 * the params do not describe the agent, so it reads as `null`.
 */
function paramReader(preset: PresetInput): (key: string) => number | null {
  const specs = getPreset(preset.id)?.params ?? [];
  return (key) => {
    const raw = preset.params[key] ?? specs.find((spec) => spec.key === key)?.default;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
}

function product(a: number | null, b: number | null, scale: number): number | null {
  return a === null || b === null ? null : a * b * scale;
}

function decimalsOf(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}
