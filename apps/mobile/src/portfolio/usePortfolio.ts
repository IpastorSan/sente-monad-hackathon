/**
 * The reads behind the Portfolio tab and your position (SEN-118, plan U-12).
 *
 * `/portfolio` and `/portfolio/fills` sit behind the manual-trading flag, so
 * they are asked for only when `useTradingEnabled()` says yes; with it off
 * the tab still has the wallet session's balances and the agents' own
 * portfolio route, which are not gated. A `/portfolio` that fails after the
 * flag said yes (a redeploy flipped it) reads the same as the flag off:
 * `portfolio` stays `null` and the screen falls back, rather than showing an
 * error for a feature that is simply not there.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Agent, AgentPortfolioDto } from '@/agents/api';
import { usePolling, type Polled } from '@/markets/usePolling';
import { useSession } from '@/session';
import type { Portfolio, PortfolioFill, PortfolioVenue } from '@/trade/types';
import { useTradingEnabled } from '@/trade/useTradingEnabled';

import {
  appendSample,
  perplFillsGap,
  type PerplFillsGap,
  type ValueSample,
  type WalletAmount,
} from './view';

/** A position's numbers move with the mark; 10 s keeps the as-of honest without hammering RPC. */
const PORTFOLIO_MS = 10_000;
const FILLS_MS = 30_000;
const FILLS_PAGE = 50;

export type UserPortfolio = {
  /** Manual trading is on for this build, this API and this network. */
  trading: boolean;
  /** `null` with trading off, before the first answer, or when the route refused. */
  portfolio: Portfolio | null;
  polled: Polled<Portfolio>;
  /**
   * What the cash card shows: `/portfolio`'s wallet, or the wallet session's
   * without it or when that section failed.
   */
  wallet: WalletAmount[] | null;
};

export function useUserPortfolio(): UserPortfolio {
  const { trade, wallet } = useSession();
  const trading = useTradingEnabled();
  const polled = usePolling(trading && trade ? 'portfolio' : null, () => trade!.portfolio(), {
    intervalMs: PORTFOLIO_MS,
  });
  const portfolio = trading ? polled.data : null;
  const walletAmounts = useMemo<WalletAmount[] | null>(() => {
    if (portfolio?.wallet.ok) {
      return portfolio.wallet.balances.map(({ symbol, amount }) => ({ symbol, amount }));
    }
    // `/portfolio`'s wallet section failed on its own (SEN-123): the wallet
    // session's `/wallet` is a separate read of the same address, so its cash
    // is still real; the screen names the failed section for the rest.
    const held = wallet.wallet;
    return held ? held.balances.map(({ symbol, amount }) => ({ symbol, amount })) : null;
  }, [portfolio, wallet.wallet]);
  return { trading, portfolio, polled, wallet: walletAmounts };
}

/** Each venue's cursor for its next, older page; `null` once it has no more (or was not read). */
type FillCursors = Record<PortfolioVenue, string | null>;
type FillPages = { fills: PortfolioFill[]; next: FillCursors };

/**
 * Your fills on both venues, with the older pages the user asked for appended
 * (`fillDays` orders them). Kuru and Perpl page separately (SEN-151): Perpl's
 * cursor is its own, so each venue is asked for by name. Perpl's page may be
 * refused — no read key, or Perpl down — and then the list is Kuru's alone
 * and `perplGap` says why, rather than the history reading as "no fills".
 */
export function useFills(trading: boolean): {
  fills: PortfolioFill[];
  perplGap: PerplFillsGap;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  const { trade } = useSession();
  const first = usePolling(
    trading && trade ? 'portfolio:fills' : null,
    async (): Promise<FillPages & { perplGap: PerplFillsGap }> => {
      const [kuru, perpl] = await Promise.allSettled([
        trade!.fills({ venue: 'kuru', limit: FILLS_PAGE }),
        trade!.fills({ venue: 'perpl', limit: FILLS_PAGE }),
      ]);
      if (kuru.status === 'rejected') throw kuru.reason;
      const perplPage = perpl.status === 'fulfilled' ? perpl.value : null;
      return {
        fills: [...kuru.value.fills, ...(perplPage?.fills ?? [])],
        next: { kuru: kuru.value.next, perpl: perplPage?.next ?? null },
        perplGap: perplFillsGap(perpl),
      };
    },
    { intervalMs: FILLS_MS },
  );
  const [older, setOlder] = useState<FillPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // A new fill at the top shifts every page, so older pages stitched to the
  // previous first page may no longer line up with it: drop them. A poll that
  // brings back the same newest fills keeps them.
  const head = (['kuru', 'perpl'] as const)
    .map((venue) => {
      const newest = first.data?.fills.find((f) => f.venue === venue);
      return newest ? `${newest.tradeId ?? ''}:${newest.venueTradeId}` : '';
    })
    .join('|');
  useEffect(() => setOlder(null), [head]);

  const next = older ? older.next : (first.data?.next ?? { kuru: null, perpl: null });
  const loadMore = useCallback(() => {
    if (!trade || (next.kuru === null && next.perpl === null) || loadingMore) return;
    setLoadingMore(true);
    const page = (venue: PortfolioVenue) => {
      const cursor = next[venue];
      return cursor === null
        ? Promise.resolve({ fills: [], next: null })
        : trade.fills({ venue, limit: FILLS_PAGE, cursor });
    };
    Promise.all([page('kuru'), page('perpl')]).then(
      ([kuru, perpl]) => {
        setOlder((prev) => ({
          fills: [...(prev?.fills ?? []), ...kuru.fills, ...perpl.fills],
          next: { kuru: kuru.next, perpl: perpl.next },
        }));
        setLoadingMore(false);
      },
      () => setLoadingMore(false),
    );
  }, [trade, next, loadingMore]);

  return {
    fills: [...(first.data?.fills ?? []), ...(older?.fills ?? [])],
    perplGap: first.data?.perplGap ?? null,
    loadingMore,
    hasMore: next.kuru !== null || next.perpl !== null,
    loadMore,
  };
}

/**
 * Each agent's `GET /agents/:id/portfolio`, re-read whenever the screen comes
 * back into view and on `pulls`. A missing route or a failed read is `null`
 * for that agent only; the group still lists it.
 */
export function useAgentPortfolios(
  agents: readonly Agent[] | null,
  pulls: number,
): ReadonlyMap<string, AgentPortfolioDto | null> | null {
  const { agents: api } = useSession();
  const [portfolios, setPortfolios] = useState<ReadonlyMap<
    string,
    AgentPortfolioDto | null
  > | null>(null);
  const ids = agents?.map((a) => a.id).join(',') ?? null;

  const load = useCallback(() => {
    if (!api || ids === null) return () => undefined;
    let live = true;
    const list = ids === '' ? [] : ids.split(',');
    void Promise.allSettled(list.map((id) => api.portfolio(id))).then((results) => {
      if (!live) return;
      setPortfolios(
        new Map(
          list.map((id, i) => {
            const result = results[i];
            return [id, result?.status === 'fulfilled' ? result.value : null];
          }),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [api, ids]);

  useFocusEffect(load);
  useEffect(() => {
    if (pulls > 0) return load();
  }, [pulls, load]);

  return portfolios;
}

/**
 * The hero line: every total the phone computed since the app opened, kept
 * at module scope so switching tabs does not wipe it. There is no value
 * history on the server; this is only what this phone saw, and says so.
 */
let observed: ValueSample[] = [];

export function useObservedValue(total: string | null, at: number | null): ValueSample[] {
  const [series, setSeries] = useState<ValueSample[]>(observed);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (total === null || at === null) return;
    const key = `${at}:${total}`;
    if (last.current === key) return;
    last.current = key;
    observed = appendSample(observed, { at, usd: total });
    setSeries(observed);
  }, [total, at]);
  return series;
}
