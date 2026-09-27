import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import {
  getPreset,
  listPresets,
  resolveParams,
  type ParamSpec,
  type PresetDefinition,
  type SuggestedMandate,
} from '@sente/presets';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AGENT_EVENTS, type AgentEventLog } from '../agents/events/agent-event-log';
import { AGENT_STORE, type AgentStore } from '../agents/store/agent-store';
import { TtlCache } from '../venues/ttl-cache';
import { activeInWindow, presetStats, type PresetStatsDto } from './preset-stats';

/** The wire contract's `PresetDto`: the catalog entry minus its functions, plus a defaults render. */
export interface PresetDto {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: ('kuru' | 'perpl')[];
  params: ParamSpec[];
  tools: string[];
  defaults: {
    params: Record<string, unknown>;
    strategy: string;
    systemPrompt: string;
    suggestedMandate: SuggestedMandate;
    suggestedCadenceSeconds: number;
  };
}

export interface PresetsResponseDto {
  presets: PresetDto[];
}

/** Stats are a 30-day aggregate: a minute stale is invisible, a log scan per card open is not. */
export const PRESET_STATS_TTL_MS = 60_000;

/**
 * A deep, mutable copy: the catalog's objects are shared by every hire, so
 * nothing handed to the serializer (or to a spec) may alias them.
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

export function toPresetDto(def: PresetDefinition): PresetDto {
  const resolved = resolveParams(def, {});
  // A preset whose defaults fail its own validation is a catalog bug that
  // `packages/presets` tests already pin; failing loudly beats a card with
  // half its data.
  if (!resolved.ok) throw new Error(`preset ${def.id}: defaults do not validate`);
  const { params } = resolved;
  const { strategy, systemPrompt } = def.render(params);
  return {
    id: def.id,
    version: def.version,
    name: def.name,
    tagline: def.tagline,
    description: def.description,
    venues: [...def.venues],
    params: copy([...def.params]),
    tools: [...def.tools],
    defaults: {
      params: copy({ ...params }),
      strategy,
      systemPrompt,
      suggestedMandate: copy(def.suggestedMandate(params)),
      suggestedCadenceSeconds: def.suggestedCadenceSeconds(params),
    },
  };
}

/**
 * `GET /presets` and `GET /presets/:id/stats` (SEN-76, plan B-T16b).
 *
 * AUTH: session-guarded like `/leaderboard`, and for the same reason it could
 * later be public: neither route reads the principal. The stats span every
 * owner's agents — a preset's record is about the preset, not the caller.
 */
@Controller('presets')
@UseGuards(SessionAuthGuard)
export class PresetsController {
  /** The catalog is static code, so its render is computed once. */
  private catalog: PresetsResponseDto | undefined;
  private readonly stats = new TtlCache<string, PresetStatsDto>();

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
  ) {}

  @Get()
  list(): PresetsResponseDto {
    this.catalog ??= { presets: listPresets().map(toPresetDto) };
    return this.catalog;
  }

  @Get(':id/stats')
  async presetStats(@Param('id') id: string): Promise<PresetStatsDto> {
    if (!getPreset(id)) {
      throw new NotFoundException({
        statusCode: 404,
        reason: 'preset_not_found',
        message: `No preset ${id} in the catalog`,
      });
    }
    const { value } = await this.stats.get(id, PRESET_STATS_TTL_MS, () => this.compute(id));
    return value;
  }

  private async compute(presetId: string): Promise<PresetStatsDto> {
    const now = Date.now();
    // `listAll`, not `listActive`: revoked agents belong in the cohort (SEN-74).
    const agents = (await this.store.listAll()).filter((a) => a.preset?.id === presetId);
    const cohort = agents.filter((a) => activeInWindow(a, now));
    const events = new Map(
      await Promise.all(
        cohort.map(async (agent) => {
          // By kind, so a chatty agent's orders and runs are never copied just to be skipped.
          const [verdicts, deposits] = await Promise.all([
            this.events.list(agent.id, { kind: 'verdict' }),
            this.events.list(agent.id, { kind: 'deposit' }),
          ]);
          return [agent.id, [...verdicts, ...deposits]] as const;
        }),
      ),
    );
    return presetStats({ presetId, agents, events, now });
  }
}
