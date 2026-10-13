/**
 * The preset catalog (SEN-68, plan B-T14a). Static: a preset is code, and a
 * change to what it tells an agent is a version bump, never a data edit.
 */
import { KURU_OPEN_ORDERS_READABLE, resolveParams } from './params.ts';
import { dcaStacker } from './presets/dca-stacker.ts';
import { fundingHarvester } from './presets/funding-harvester.ts';
import { guardian } from './presets/guardian.ts';
import { meanReverter } from './presets/mean-reverter.ts';
import { rangeTrader } from './presets/range-trader.ts';
import { trendRider } from './presets/trend-rider.ts';
import type { ParamError, Params, PresetDefinition } from './types.ts';

// Catalog order is display order; Guardian is the featured card, so it leads,
// and the rest follow agents.html, "The catalog" (SEN-72).
const PRESETS: readonly PresetDefinition[] = [
  guardian,
  rangeTrader,
  trendRider,
  fundingHarvester,
  dcaStacker,
  meanReverter,
];

/**
 * The presets that can be hired on the active deployment. Range Trader is
 * withheld while Kuru's open orders cannot be read (Set C, SEN-203): its
 * target is a resting sell it must find again on every run.
 */
const OFFERED: readonly PresetDefinition[] = KURU_OPEN_ORDERS_READABLE
  ? PRESETS
  : PRESETS.filter((preset) => preset !== rangeTrader);

/** The hireable catalog, in display order. */
export function listPresets(): readonly PresetDefinition[] {
  return OFFERED;
}

/**
 * Any preset by id, offered or not: an agent hired from one still needs its
 * name and params. Hiring goes through {@link renderPreset}, which only takes
 * an offered one.
 */
export function getPreset(id: string): PresetDefinition | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Whether `id` can be hired on the active deployment. */
export function isPresetOffered(id: string): boolean {
  return OFFERED.some((preset) => preset.id === id);
}

export type RenderResult =
  | {
      ok: true;
      id: PresetDefinition['id'];
      version: number;
      params: Params;
      strategy: string;
      systemPrompt: string;
    }
  | { ok: false; errors: ParamError[] };

/** What hiring from a preset runs (B-T15): look up, validate, render. */
export function renderPreset(id: string, raw: Record<string, unknown>): RenderResult {
  const def = getPreset(id);
  if (!def) return { ok: false, errors: [{ key: 'id', message: `unknown preset ${id}` }] };
  if (!isPresetOffered(id)) {
    return {
      ok: false,
      errors: [
        {
          key: 'id',
          message: `${def.name} is not available on this Kuru deployment: it cannot read back its resting orders`,
        },
      ],
    };
  }
  const resolved = resolveParams(def, raw);
  if (!resolved.ok) return resolved;
  const { strategy, systemPrompt } = def.render(resolved.params);
  return {
    ok: true,
    id: def.id,
    version: def.version,
    params: resolved.params,
    strategy,
    systemPrompt,
  };
}
