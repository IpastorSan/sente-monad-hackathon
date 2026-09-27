/**
 * What an agent holds, across its wallet, Kuru and Perpl (SEN-78, plan B-T9).
 *
 * The venue reads themselves are the address-level helpers in
 * `venue-reads.ts`, shared with the user portfolio; this service adds what is
 * specific to an agent: whether Perpl is in its mandate, whether it holds
 * Perpl credentials, and the cost basis of its spot holdings from its event
 * log. No route here — `GET /agents/:id/portfolio` is B-T10.
 *
 * Each section is read independently and reported as a `SectionResult`, so a
 * venue that is down costs that section, never the whole response: the
 * cockpit still shows the wallet while Perpl's socket is refusing connections.
 */
import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';
import { KURU_TESTNET_MARKETS } from '@sente/venues/kuru';
import { BaseError, type Address, type PublicClient } from 'viem';

import { MarketDataService } from '../../venues/market-data.service';
import {
  ViemTokenBalanceReader,
  type TokenBalanceReader,
} from '../../wallet/balances/token-balances';
import type {
  AgentPortfolioDto,
  BalanceDto,
  Decimal,
  SectionResult,
  SpotHoldingDto,
} from '../../venues/dto/markets.dto';
import { AGENT_EVENTS, type AgentEvent, type AgentEventLog } from '../events/agent-event-log';
import { addScaled, decimalOf, decimalString, type Scaled } from '../events/verdict';
import type { AgentRecord } from '../store/agent-store';
import { mulDecimal } from '../tools/decimal';
import type { AgentIdentity } from '../venues/agent-transactions';
import { AgentVenues } from '../venues/agent-venues';
import { AGENT_PUBLIC_CLIENT } from '../venues/agent-venues.providers';
import { perplAccountInfo } from '../venues/perpl-agent';
import { fifoCostBasis, reconcileHolding } from './cost-basis';
import {
  AGENT_WALLET_TOKENS,
  kuruAccountVenue,
  readKuruAccount,
  readPerplAccount,
  readWalletBalances,
  type KuruAccountVenue,
  type PerplAccountInfoReader,
  type PerplAccountVenue,
} from './venue-reads';

/** How long one agent's portfolio is served from memory. */
export const AGENT_PORTFOLIO_TTL_MS = 3_000;

/** Everything the service reads through: the seam the spec fakes. */
export interface AgentPortfolioReaders {
  readonly wallet: TokenBalanceReader;
  readonly kuruVenue: (address: Address) => KuruAccountVenue;
  /**
   * Runs `read` against the agent's credentialed Perpl venue (`undefined` when
   * it holds no API key). A callback rather than a getter so the reader, not
   * the service, owns the socket's lifetime: a polled portfolio must not keep
   * the agent's trading socket open (SEN-122).
   */
  readonly withPerplVenue: <T>(
    agent: AgentIdentity,
    read: (venue: PerplAccountVenue | undefined) => Promise<T>,
  ) => Promise<T>;
  readonly perplAccountInfo: PerplAccountInfoReader;
  readonly events: Pick<AgentEventLog, 'list'>;
  readonly marks: Pick<MarketDataService, 'mark'>;
  readonly now?: () => number;
}

export const AGENT_PORTFOLIO_READERS = Symbol('AGENT_PORTFOLIO_READERS');

const TOTALS_NOTE =
  '≈ $: USDC and AUSD counted at $1, spot holdings at their Kuru mark (unpriced ones left out; ' +
  'MON includes the wallet gas), Perpl as collateral plus unrealised PnL.';

@Injectable()
export class AgentPortfolioService {
  readonly #logger = new Logger(AgentPortfolioService.name);
  readonly #readers: AgentPortfolioReaders;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; value: Promise<AgentPortfolioDto> }>();

  constructor(@Inject(AGENT_PORTFOLIO_READERS) readers: AgentPortfolioReaders) {
    this.#readers = readers;
    this.#now = readers.now ?? Date.now;
  }

  /**
   * The agent's portfolio, at most {@link AGENT_PORTFOLIO_TTL_MS} old. Callers
   * inside that window share one read, in flight or done, so a cockpit polling
   * every second costs one set of RPC calls per 3 s, not one per poll.
   */
  portfolio(agent: AgentRecord): Promise<AgentPortfolioDto> {
    const now = this.#now();
    const hit = this.#cache.get(agent.id);
    if (hit && now - hit.at < AGENT_PORTFOLIO_TTL_MS) return hit.value;

    for (const [id, entry] of this.#cache) {
      if (now - entry.at >= AGENT_PORTFOLIO_TTL_MS) this.#cache.delete(id);
    }
    const value = this.#read(agent, now);
    this.#cache.set(agent.id, { at: now, value });
    // Sections swallow their own failures, so this is a bug path; still, a
    // rejected read must not be served for the next 3 s.
    value.catch(() => {
      if (this.#cache.get(agent.id)?.value === value) this.#cache.delete(agent.id);
    });
    return value;
  }

  async #read(agent: AgentRecord, asOf: number): Promise<AgentPortfolioDto> {
    const identity: AgentIdentity = {
      agentId: agent.id,
      walletId: agent.walletId,
      address: agent.address,
    };
    const [wallet, kuru, perpl, events, marks] = await Promise.all([
      this.#section('wallet', agent.id, async () => ({
        balances: await readWalletBalances(this.#readers.wallet, agent.address),
      })),
      this.#section('kuru', agent.id, () =>
        readKuruAccount(this.#readers.kuruVenue(agent.address)),
      ),
      this.#section('perpl', agent.id, async () => {
        // Not in the mandate means the agent cannot trade there, so any
        // account it has is not this agent's business to show.
        if (!agent.mandate.venues.includes('perpl')) return { status: 'not_in_mandate' as const };
        return this.#readers.withPerplVenue(identity, (venue) =>
          readPerplAccount(agent.address, { accountInfo: this.#readers.perplAccountInfo, venue }),
        );
      }),
      this.#events(agent.id),
      // Every market's mark, alongside the sections rather than after them:
      // four cached reads cost less than another round trip.
      Promise.all(
        KURU_TESTNET_MARKETS.map((market) =>
          this.#readers.marks.mark('kuru', market.symbol).catch(() => null),
        ),
      ),
    ]);

    const holdings = this.#holdings(wallet, kuru, events, marks);
    return {
      agentId: agent.id,
      address: agent.address,
      asOf,
      wallet,
      kuru,
      perpl,
      holdings,
      totals: totals(wallet, kuru, perpl, holdings),
    };
  }

  /**
   * One spot holding per Kuru base token the agent has any of, wherever it
   * sits: its wallet, free in AccountCore, or reserved by a resting order.
   */
  #holdings(
    wallet: AgentPortfolioDto['wallet'],
    kuru: AgentPortfolioDto['kuru'],
    events: readonly AgentEvent[] | null,
    marks: readonly (Decimal | null)[],
  ): SpotHoldingDto[] {
    const rows = KURU_TESTNET_MARKETS.map((market, i) => {
      const asset = market.base.symbol;
      const inWallet = (wallet.ok && find(wallet.balances, asset)?.total) || '0';
      const account = kuru.ok ? find(kuru.balances, asset) : undefined;
      const inAccount = account?.available ?? '0';
      const lockedInOrders = account?.locked ?? '0';
      return {
        market,
        asset,
        markPrice: marks[i] ?? null,
        inWallet,
        inAccount,
        lockedInOrders,
        amount: sum([inWallet, inAccount, lockedInOrders]),
      };
    }).filter((row) => decimalOf(row.amount)?.units !== 0n);

    return rows.map((row) => {
      const { markPrice } = row;
      const basis = reconcileHolding(
        fifoCostBasis(events ?? [], row.market.symbol),
        row.amount,
        markPrice,
      );
      const notes: string[] = [];
      if (row.asset === 'MON') notes.push('Wallet MON includes gas.');
      if (!wallet.ok || !kuru.ok) {
        notes.push(`The ${!wallet.ok ? 'wallet' : 'Kuru'} read failed; amount leaves it out.`);
      }
      if (events === null) notes.push('Event log unavailable; cost basis unknown.');
      return {
        asset: row.asset,
        market: row.market.symbol,
        amount: row.amount,
        inWallet: row.inWallet,
        inAccount: row.inAccount,
        lockedInOrders: row.lockedInOrders,
        markPrice,
        value: markPrice === null ? null : mulDecimal(row.amount, markPrice),
        costBasis: { ...basis, source: 'event-log-fifo' as const },
        ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      };
    });
  }

  /** The whole log: FIFO needs every buy, however old. `null` when unreadable. */
  async #events(agentId: string): Promise<AgentEvent[] | null> {
    try {
      return await this.#readers.events.list(agentId);
    } catch (error) {
      this.#logger.warn(`Agent ${agentId}: event log read failed: ${messageOf(error)}`);
      return null;
    }
  }

  async #section<T extends object>(
    name: string,
    agentId: string,
    read: () => Promise<T>,
  ): Promise<SectionResult<T>> {
    try {
      return { ok: true, ...(await read()) };
    } catch (error) {
      this.#logger.warn(`Agent ${agentId}: portfolio ${name} read failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
  }
}

function totals(
  wallet: AgentPortfolioDto['wallet'],
  kuru: AgentPortfolioDto['kuru'],
  perpl: AgentPortfolioDto['perpl'],
  holdings: readonly SpotHoldingDto[],
): AgentPortfolioDto['totals'] {
  const walletBalances = wallet.ok ? wallet.balances : [];
  const kuruBalances = kuru.ok ? kuru.balances : [];

  const usdc = sum([
    find(walletBalances, 'USDC')?.total ?? '0',
    find(kuruBalances, 'USDC')?.total ?? '0',
    ...holdings.flatMap((h) => (h.value === null ? [] : [h.value])),
  ]);
  const ausd = sum([
    find(walletBalances, 'AUSD')?.total ?? '0',
    ...(perpl.ok && 'balances' in perpl ? perpl.balances.map((b) => b.total) : []),
    ...(perpl.ok && perpl.status === 'ok' ? perpl.positions.map((p) => p.unrealizedPnl) : []),
  ]);

  const missing = [!wallet.ok && 'wallet', !kuru.ok && 'Kuru', !perpl.ok && 'Perpl'].filter(
    (name): name is string => typeof name === 'string',
  );
  return {
    approxUsd: sum([usdc, ausd]),
    byQuote: { USDC: usdc, AUSD: ausd },
    note:
      missing.length > 0
        ? `${TOTALS_NOTE} Leaves out ${missing.join(', ')}: the read failed.`
        : TOTALS_NOTE,
  };
}

function find<T extends BalanceDto>(balances: readonly T[], asset: string): T | undefined {
  return balances.find((balance) => balance.asset === asset);
}

/** Exact, signed (uPnL can be negative); an unparsable entry is a bug upstream, not zero. */
function sum(values: readonly Decimal[]): Decimal {
  let total: Scaled = { units: 0n, scale: 0 };
  for (const value of values) {
    const parsed = decimalOf(value);
    if (!parsed) throw new RangeError(`portfolio: "${value}" is not a decimal`);
    total = addScaled(total, parsed);
  }
  return decimalString(total);
}

/**
 * viem's full message carries the request, RPC URL included, and that URL can
 * hold a provider key; the short message is what is safe to hand the phone.
 */
function messageOf(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** The real readers over the agents' public client and venues. */
export function agentPortfolioReaders(
  client: PublicClient,
  venues: Pick<AgentVenues, 'readPerpl'>,
  events: Pick<AgentEventLog, 'list'>,
  marks: Pick<MarketDataService, 'mark'>,
): AgentPortfolioReaders {
  return {
    wallet: new ViemTokenBalanceReader(client, AGENT_WALLET_TOKENS),
    kuruVenue: (address) => kuruAccountVenue(client, address),
    // Never `venues.forAgent`: that keeps the socket open (SEN-122).
    withPerplVenue: (agent, read) => venues.readPerpl(agent, read),
    perplAccountInfo: (address) => perplAccountInfo(client, address),
    events,
    marks,
  };
}

/** Nest wiring. */
export const agentPortfolioProviders: Provider[] = [
  {
    provide: AGENT_PORTFOLIO_READERS,
    inject: [AGENT_PUBLIC_CLIENT, AgentVenues, AGENT_EVENTS, MarketDataService],
    useFactory: agentPortfolioReaders,
  },
  AgentPortfolioService,
];
