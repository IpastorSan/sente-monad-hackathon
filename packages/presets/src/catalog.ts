/**
 * The preset catalog (SEN-68, plan B-T14a). Static: a preset is code, and a
 * change to what it tells an agent is a version bump, never a data edit.
 */
import { resolveParams } from './params.ts';
import { guardian } from './presets/guardian.ts';
import { rangeTrader } from './presets/range-trader.ts';
import type { ParamError, Params, PresetDefinition } from './types.ts';

// Catalog order is display order; Guardian is the featured card, so it leads.
const PRESETS: readonly PresetDefinition[] = [guardian, rangeTrader];

export function listPresets(): readonly PresetDefinition[] {
  return PRESETS;
}

export function getPreset(id: string): PresetDefinition | undefined {
  return PRESETS.find((preset) => preset.id === id);
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
