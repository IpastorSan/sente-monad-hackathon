/**
 * The preset catalog as the phone shows it (SEN-114).
 *
 * Two sources, one shape. `GET /presets` wins when the API serves it, because
 * it is the catalog the server will accept a hire against (B-T15 renders the
 * preset server-side from `{id, params}`). Until B-T16b is deployed — or on an
 * API that predates it — the gallery is built from the copy of
 * `@sente/presets` bundled into the app, mapped to the same `PresetDto` the
 * route returns, so a card cannot tell which one it was drawn from.
 *
 * The package is dependency-free TypeScript designed to load through Metro,
 * so bundling it costs the six definitions and their render text, nothing
 * else.
 */
import { listPresets, resolveParams, type PresetDefinition } from '@sente/presets';

import type { PresetDto } from './api.ts';

export type CatalogSource = 'api' | 'bundled';

/** One definition as `GET /presets` would serve it: functions evaluated at the defaults. */
export function presetToDto(def: PresetDefinition): PresetDto {
  const resolved = resolveParams(def, {});
  // Defaults that fail their own validation are a bug in the package, which
  // its own spec pins; refusing here would blank the whole gallery for it.
  if (!resolved.ok) throw new Error(`preset ${def.id}: defaults do not validate`);
  const { params } = resolved;
  const rendered = def.render(params);
  return {
    id: def.id,
    version: def.version,
    name: def.name,
    tagline: def.tagline,
    description: def.description,
    venues: [...def.venues],
    params: [...def.params],
    tools: [...def.tools],
    defaults: {
      params: { ...params },
      strategy: rendered.strategy,
      systemPrompt: rendered.systemPrompt,
      suggestedMandate: def.suggestedMandate(params),
      suggestedCadenceSeconds: def.suggestedCadenceSeconds(params),
    },
  };
}

/** The bundled catalog, in the package's display order (Guardian leads). */
export function bundledCatalog(): PresetDto[] {
  return listPresets().map(presetToDto);
}
