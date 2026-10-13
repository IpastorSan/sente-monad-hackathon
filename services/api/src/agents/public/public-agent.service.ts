/**
 * The public agent page's answer (SEN-193), assembled from what the owner's
 * agent page already reads — the store, the event-log summary, the portfolio —
 * and cached for {@link PUBLIC_AGENT_TTL_MS}, because a shared link is opened
 * by many people at once and every one of them would otherwise read the chain.
 *
 * Read-only. It writes nothing anywhere.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PROFILE_STORE, type ProfileStore } from '../../profile/profile.store';
import { AGENT_EVENTS, type AgentEventLog } from '../events/agent-event-log';
import { marketFills } from '../events/market-fills';
import { summariseEvents } from '../events/summary';
import { AgentPortfolioService, holdingAmounts } from '../portfolio/portfolio.service';
import { AGENT_STORE, type AgentStore } from '../store/agent-store';
import {
  isPublished,
  PUBLIC_RECENT_LIMIT,
  toPublicAgent,
  type PublicAgentDto,
  type PublicBalanceDto,
} from './public-agent.dto';

/** How long one answer is served to everyone who asks. */
export const PUBLIC_AGENT_TTL_MS = 15_000;
/** Past this many cached ids, expired entries are swept; past it again, the cache is reset. */
const CACHE_MAX = 1_000;

/** `null` is "no such public agent": cached too, so probing ids costs no store scans. */
type Answer = PublicAgentDto | null;

@Injectable()
export class PublicAgentService {
  readonly #logger = new Logger(PublicAgentService.name);
  readonly #cache = new Map<string, { at: number; value: Promise<Answer> }>();
  readonly #now: () => number;

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
    @Inject(PROFILE_STORE) private readonly profiles: Pick<ProfileStore, 'get'>,
    @Optional() private readonly portfolios?: AgentPortfolioService,
    @Optional() @Inject('PUBLIC_AGENT_NOW') now?: () => number,
  ) {
    this.#now = now ?? Date.now;
  }

  /** The public page of `id`, or `null` when there is none to show. */
  get(id: string): Promise<Answer> {
    const now = this.#now();
    const hit = this.#cache.get(id);
    if (hit && now - hit.at < PUBLIC_AGENT_TTL_MS) return hit.value;
    if (this.#cache.size >= CACHE_MAX) {
      for (const [key, entry] of this.#cache) {
        if (now - entry.at >= PUBLIC_AGENT_TTL_MS) this.#cache.delete(key);
      }
      if (this.#cache.size >= CACHE_MAX) this.#cache.clear();
    }
    const value = this.#read(id, now);
    this.#cache.set(id, { at: now, value });
    value.catch(() => {
      if (this.#cache.get(id)?.value === value) this.#cache.delete(id);
    });
    return value;
  }

  async #read(id: string, now: number): Promise<Answer> {
    const agent = await this.store.get(id);
    if (!isPublished(agent)) return null;
    const [events, truncation, all, balance] = await Promise.all([
      this.events.list(id),
      this.events.truncation(id),
      this.store.listAll(),
      this.#balance(agent),
    ]);
    const { lastEvent: _lastEvent, ...summary } = summariseEvents(events, now, truncation);
    return toPublicAgent({
      agent,
      owner: { name: this.profiles.get(agent.userId).name },
      summary,
      fills: marketFills([{ agent: { id: agent.id, name: agent.name }, events }], {
        limit: PUBLIC_RECENT_LIMIT,
      }),
      refusals: events.filter((event) => event.kind === 'refusal'),
      copies: all.filter((other) => other.forkedFrom === agent.id).length,
      balance,
      now,
    });
  }

  async #balance(
    agent: Parameters<AgentPortfolioService['portfolio']>[0],
  ): Promise<PublicBalanceDto | null> {
    if (!this.portfolios) return null;
    try {
      const portfolio = await this.portfolios.portfolio(agent);
      const { totals } = portfolio;
      return { approxUsd: totals.approxUsd, amounts: holdingAmounts(portfolio), note: totals.note };
    } catch (error) {
      this.#logger.warn(`public agent ${agent.id}: balance unreadable (${String(error)})`);
      return null;
    }
  }
}
