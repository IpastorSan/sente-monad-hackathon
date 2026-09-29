/**
 * The preset a hire is configured against: the server's, when it says (SEN-160).
 *
 * A hire sends `{id, version, params}` and the API refuses any version but its
 * own (`preset_invalid`, SEN-73). Taking the version from the copy of
 * `@sente/presets` bundled into the app meant one preset bump on the server
 * broke hiring from every build already installed. So `GET /presets` is the
 * source of truth for the version, the param specs (ranges, options,
 * defaults) and the suggested mandate at the defaults; the bundle only
 * supplies what the wire cannot carry — the functions that answer for
 * non-default params and the cross-param `validate` — and stands in whole only
 * when the route is missing (an API that predates B-T16b).
 *
 * The bundle's functions and this app's screens know each preset's params by
 * key and type. When the server serves a param this build cannot draw — a new
 * key, or a type the controls don't know — no amount of mapping makes an
 * honest form, so the preset is `update-app`: the screen asks for an update
 * and nothing is sent.
 *
 * Pure, so `served.test.ts` pins it without a device.
 */
import {
  getPreset,
  type ParamSpec,
  type Params,
  type PresetDefinition,
  type SuggestedMandate,
} from '@sente/presets';

import { isUnavailable, type PresetDto, type PresetsApi } from './api.ts';
import { presetToDto, type CatalogSource } from './catalog.ts';

export type HirePreset =
  /** `def` is what the configure flow reads; `dto` what the detail page shows. */
  | { kind: 'ready'; def: PresetDefinition; dto: PresetDto; source: CatalogSource }
  /** The server's preset has params this build can't render: hiring it needs an update. */
  | { kind: 'update-app'; dto: PresetDto }
  /** Neither the server (when it answered) nor the bundle has it. */
  | { kind: 'missing' };

/** The param types `presets/params.ts` has a control for. */
const RENDERABLE_TYPES: ReadonlySet<string> = new Set(['number', 'enum', 'boolean', 'market']);

/**
 * Whether every served param is one this build can draw and reason about:
 * a known control type, and a key the bundled preset already has. Keys
 * matter as much as types — the read-back, the funding suggestion and the
 * price-level tags are written per key.
 */
export function canRender(served: Pick<PresetDto, 'params'>, bundled: PresetDefinition): boolean {
  const known = new Set(bundled.params.map((spec) => spec.key));
  // Read as plain strings: a newer server can serve a type this build's
  // `ParamSpec` union has never heard of.
  return served.params.every(
    (spec: { key: string; type: string }) => RENDERABLE_TYPES.has(spec.type) && known.has(spec.key),
  );
}

function sameParams(a: Params, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/**
 * The bundled definition under the server's version and specs. Validation is
 * still `resolveParams`, run on the served specs (with the bundle's
 * cross-param rule), so the phone checks the ranges the server will. At the
 * server's defaults its own suggested mandate and cadence win; elsewhere only
 * the bundle's functions can answer.
 */
export function servedDefinition(bundled: PresetDefinition, served: PresetDto): PresetDefinition {
  const atDefaults = (p: Params) => sameParams(p, served.defaults.params);
  return {
    ...bundled,
    version: served.version,
    name: served.name,
    tagline: served.tagline,
    description: served.description,
    params: served.params as readonly ParamSpec[],
    suggestedCadenceSeconds: (p) =>
      atDefaults(p) ? served.defaults.suggestedCadenceSeconds : bundled.suggestedCadenceSeconds(p),
    suggestedMandate: (p): SuggestedMandate =>
      atDefaults(p) ? served.defaults.suggestedMandate : bundled.suggestedMandate(p),
  };
}

/**
 * The preset to hire `id` against. `served` is `GET /presets`'s list, or
 * `null` when the route is missing — then, and only then, the bundle stands in.
 */
export function hirePresetFrom(id: string, served: readonly PresetDto[] | null): HirePreset {
  const bundled = getPreset(id);
  if (served === null) {
    return bundled
      ? { kind: 'ready', def: bundled, dto: presetToDto(bundled), source: 'bundled' }
      : { kind: 'missing' };
  }
  const dto = served.find((preset) => preset.id === id);
  if (!dto) return { kind: 'missing' };
  if (!bundled || !canRender(dto, bundled)) return { kind: 'update-app', dto };
  return { kind: 'ready', def: servedDefinition(bundled, dto), dto, source: 'api' };
}

/**
 * Asks the server, then decides. No session (`api` null) or a 404 falls back
 * to the bundle; any other failure throws, because a guess at the version is
 * exactly the stale hire this exists to prevent.
 */
export async function loadHirePreset(api: PresetsApi | null, id: string): Promise<HirePreset> {
  if (!api) return hirePresetFrom(id, null);
  try {
    const { presets } = await api.list();
    return hirePresetFrom(id, presets);
  } catch (error) {
    if (isUnavailable(error)) return hirePresetFrom(id, null);
    throw error;
  }
}
