/**
 * Takes and serves the value snapshots (SEN-152).
 *
 * ## Cadence
 *
 * A timer ticks every `tickSeconds` (60 by default). Each tick snapshots every
 * subject whose last point is at least `everyMs` old (an hour by default), and
 * every subject that has TRADED since its last point, at most once per
 * {@link TRADE_MIN_GAP_MS}. "Due" is read off the stored last point rather
 * than a timer per subject, so a restart neither double-records an hour nor
 * forgets one: the first tick after boot catches up whoever is due.
 *
 * A trade is noticed by polling what is already in memory — the user's trade
 * store, the agent's event log — rather than hooking the executor and the
 * tool gate: a missed hook would be silent, a poll of a `Map` costs nothing.
 *
 * ## Who is recorded
 *
 * Every agent, revoked ones too while they still hold money, since the hero's
 * total counts them. Users only while manual trading is on (the route is
 * behind the same flag, so nobody could read theirs otherwise), and only users
 * who have asked for their history, own an agent, or already have points —
 * the registry has no "every user" read, and a user who never opens the app
 * need not cost an hourly RPC round.
 *
 * Reads go through the portfolio services, so their caches apply, and
 * subjects are read one after another: a tick that opened every agent's Perpl
 * socket at once would spend Perpl's ~10/min sign-in budget in one go.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AgentEventLog } from '../../agents/events/agent-event-log';
import type { AgentRecord, AgentStore } from '../../agents/store/agent-store';
import type { Principal } from '../../auth/principal';
import type { TradeStore } from '../../trade/trade-store';
import type { AgentPortfolioDto, TickerDto } from '../../venues/dto/markets.dto';
import { WalletRefusedError } from '../../wallet/wallet.errors';
import type { PortfolioDto } from '../dto/portfolio.dto';
import { downsample, windowStart } from './downsample';
import {
  agentValuation,
  priceBook,
  userValuation,
  type PriceBook,
  type Valuation,
} from './valuation';
import type { HistoryRange, ValueHistoryDto } from './value-history.dto';
import type { HistoryKind, ValueHistoryStore } from './value-history.store';

export const HOUR_MS = 3_600_000;

/** A trade triggers a point at most this often per subject, so an agent trading every minute stays hourly-ish. */
export const TRADE_MIN_GAP_MS = 5 * 60_000;

export interface ValueHistoryConfig {
  /** How often a point is taken without a trade. */
  readonly everyMs: number;
  /** How often the timer checks who is due; `undefined` = no timer (specs, `off`). */
  readonly tickSeconds: number | undefined;
}

export const VALUE_HISTORY_CONFIG = Symbol('VALUE_HISTORY_CONFIG');

/** `VALUE_HISTORY_TICK_SECONDS` (default 60, `0`/`off` = no timer), `VALUE_HISTORY_EVERY_SECONDS` (default 3600). */
export function loadValueHistoryConfig(
  env: Record<string, string | undefined> = process.env,
): ValueHistoryConfig {
  const tick = env.VALUE_HISTORY_TICK_SECONDS?.trim();
  const every = env.VALUE_HISTORY_EVERY_SECONDS?.trim();
  const tickSeconds = tick === undefined || tick === '' ? 60 : tick === 'off' ? 0 : Number(tick);
  const everySeconds = every === undefined || every === '' ? 3600 : Number(every);
  if (!Number.isFinite(tickSeconds) || tickSeconds < 0) {
    throw new Error('VALUE_HISTORY_TICK_SECONDS must be a number of seconds, 0 or off');
  }
  if (!Number.isFinite(everySeconds) || everySeconds < 60) {
    throw new Error('VALUE_HISTORY_EVERY_SECONDS must be at least 60');
  }
  return { everyMs: everySeconds * 1000, tickSeconds: tickSeconds > 0 ? tickSeconds : undefined };
}

/** Everything the service reads through: the seam the spec fakes. */
export interface ValueHistoryReaders {
  readonly store: ValueHistoryStore;
  readonly userPortfolio: (principal: Principal) => Promise<PortfolioDto>;
  readonly agentPortfolio: (agent: AgentRecord) => Promise<AgentPortfolioDto>;
  readonly kuruTickers: () => Promise<readonly TickerDto[]>;
  readonly agents: Pick<AgentStore, 'listAll'>;
  readonly trades: Pick<TradeStore, 'listRecent'>;
  readonly events: Pick<AgentEventLog, 'list'>;
  /** The manual-trading flag: users are recorded only while it is on. */
  readonly tradingEnabled: boolean;
  readonly now?: () => number;
}

export const VALUE_HISTORY_READERS = Symbol('VALUE_HISTORY_READERS');

export type TickResult = { users: number; agents: number };

const NOTE =
  '≈ $: USDC and AUSD counted at $1, other tokens at their Kuru price, Perpl as collateral ' +
  'plus unrealised PnL. A partial point left out something that did not answer at the time.';

const ALL = Number.MAX_SAFE_INTEGER;

@Injectable()
export class ValueHistoryService {
  readonly #readers: ValueHistoryReaders;
  readonly #config: ValueHistoryConfig;
  readonly #now: () => number;
  readonly #logger = new Logger(ValueHistoryService.name);
  /** Users who asked for their history since boot; the ones with points come from the store. */
  readonly #tracked = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<TickResult> | undefined;

  constructor(
    @Inject(VALUE_HISTORY_READERS) readers: ValueHistoryReaders,
    @Inject(VALUE_HISTORY_CONFIG) config: ValueHistoryConfig,
  ) {
    this.#readers = readers;
    this.#config = config;
    this.#now = readers.now ?? Date.now;
  }

  onApplicationBootstrap(): void {
    const seconds = this.#config.tickSeconds;
    if (seconds === undefined || this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.tick(), seconds * 1000);
    this.#timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Record this user from the next tick on. */
  track(userId: string): void {
    this.#tracked.add(userId);
  }

  history(kind: HistoryKind, id: string, range: HistoryRange): ValueHistoryDto {
    const asOf = this.#now();
    const all = this.#readers.store.list(kind, id);
    const from = windowStart(all, range, asOf);
    const points = downsample(all, from, asOf).map((s) => ({
      at: s.at,
      usd: s.usd,
      ...(s.partial ? { partial: true as const } : {}),
    }));
    return {
      range,
      asOf,
      from,
      points,
      partial: points.some((p) => p.partial),
      everyMs: this.#config.everyMs,
      note: NOTE,
    };
  }

  /** One pass. Joins a tick already running rather than starting a second. Never throws. */
  tick(): Promise<TickResult> {
    this.#ticking ??= this.#tick()
      .catch((error: unknown) => {
        this.#logger.error(`value history tick failed: ${String(error)}`);
        return { users: 0, agents: 0 };
      })
      .finally(() => {
        this.#ticking = undefined;
      });
    return this.#ticking;
  }

  async #tick(): Promise<TickResult> {
    const { store } = this.#readers;
    const now = this.#now();
    const agents = await this.#readers.agents.listAll();
    // Read at most once per tick, shared by the agents a user's total needs.
    const agentValues = new Map<string, Promise<Valuation | null>>();
    // A revoked agent emptied by its return has nothing left to chart, and
    // nothing to add to its owner's total: no need to read it every hour.
    const emptied = (agent: AgentRecord) => {
      const last = store.last('agent', agent.id);
      return (
        agent.status === 'revoked' && last !== undefined && !last.partial && !/[1-9]/.test(last.usd)
      );
    };
    const valueOf = (agent: AgentRecord) => {
      let value = agentValues.get(agent.id);
      if (!value && emptied(agent)) {
        value = Promise.resolve({ usd: '0', partial: false });
        agentValues.set(agent.id, value);
      }
      if (!value) {
        value = this.#readers
          .agentPortfolio(agent)
          .then(agentValuation)
          .catch((error: unknown) => {
            this.#logger.warn(`agent ${agent.id}: portfolio read failed: ${String(error)}`);
            return null;
          });
        agentValues.set(agent.id, value);
      }
      return value;
    };

    let agentsRecorded = 0;
    for (const agent of agents) {
      if (emptied(agent) || !(await this.#agentDue(agent.id, now))) continue;
      const value = await valueOf(agent);
      if (value === null) continue;
      store.append('agent', agent.id, snapshot(now, value));
      agentsRecorded += 1;
    }

    let usersRecorded = 0;
    if (this.#readers.tradingEnabled) {
      const users = new Set([
        ...store.ids('user'),
        ...this.#tracked,
        ...agents.map((agent) => agent.userId),
      ]);
      let prices: Promise<PriceBook> | undefined;
      for (const userId of users) {
        if (!this.#userDue(userId, now)) continue;
        let portfolio: PortfolioDto;
        try {
          portfolio = await this.#readers.userPortfolio({ userId });
        } catch (error) {
          // No wallet registered: nothing to value, and nothing to retry each tick.
          if (error instanceof WalletRefusedError) this.#tracked.delete(userId);
          else this.#logger.warn(`user ${userId}: portfolio read failed: ${String(error)}`);
          continue;
        }
        prices ??= this.#readers.kuruTickers().then(priceBook, () => null);
        const own = agents.filter((agent) => agent.userId === userId);
        const value = userValuation(portfolio, await prices, await Promise.all(own.map(valueOf)));
        store.append('user', userId, snapshot(now, value));
        usersRecorded += 1;
      }
    }
    return { users: usersRecorded, agents: agentsRecorded };
  }

  async #agentDue(agentId: string, now: number): Promise<boolean> {
    const last = this.#readers.store.last('agent', agentId);
    if (!last || now - last.at >= this.#config.everyMs) return true;
    if (now - last.at < TRADE_MIN_GAP_MS) return false;
    const [fill] = await this.#readers.events.list(agentId, { kind: 'fill', limit: 1 });
    return fill !== undefined && fill.at > last.at;
  }

  #userDue(userId: string, now: number): boolean {
    const last = this.#readers.store.last('user', userId);
    if (!last || now - last.at >= this.#config.everyMs) return true;
    if (now - last.at < TRADE_MIN_GAP_MS) return false;
    // A trade that landed after the last point. `completed` is the executor's
    // last word; a failed one moved nothing worth a point.
    return this.#readers.trades
      .listRecent(userId, ALL)
      .some((trade) => trade.status === 'completed' && trade.updatedAt.getTime() > last.at);
  }
}

function snapshot(at: number, value: Valuation) {
  return { at, usd: value.usd, ...(value.partial ? { partial: true as const } : {}) };
}
