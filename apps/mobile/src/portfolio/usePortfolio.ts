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
import type { Portfolio, PortfolioFill } from '@/trade/types';
import { useTradingEnabled } from '@/trade/useTradingEnabled';

import { appendSample, type ValueSample, type WalletAmount } from './view';

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
  /** What the cash card shows: `/portfolio`'s wallet, or the wallet session's without it. */
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
    if (portfolio) return portfolio.wallet.map(({ symbol, amount }) => ({ symbol, amount }));
    const held = wallet.wallet;
    return held ? held.balances.map(({ symbol, amount }) => ({ symbol, amount })) : null;
  }, [portfolio, wallet.wallet]);
  return { trading, portfolio, polled, wallet: walletAmounts };
}

/** Your fills, newest first, with the older pages the user asked for appended. */
export function useFills(trading: boolean): {
  fills: PortfolioFill[];
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  const { trade } = useSession();
  const first = usePolling(
    trading && trade ? 'portfolio:fills' : null,
    () => trade!.fills({ limit: FILLS_PAGE }),
    { intervalMs: FILLS_MS },
  );
  const [older, setOlder] = useState<{ fills: PortfolioFill[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // A new fill at the top shifts every page, so older pages stitched to the
  // previous first page may no longer line up with it: drop them. A poll that
  // brings back the same newest fill keeps them.
  const newest = first.data?.fills[0];
  const head = newest ? `${newest.tradeId}:${newest.venueTradeId}` : null;
  useEffect(() => setOlder(null), [head]);

  const next = older ? older.next : (first.data?.next ?? null);
  const loadMore = useCallback(() => {
    if (!trade || next === null || loadingMore) return;
    setLoadingMore(true);
    trade.fills({ limit: FILLS_PAGE, cursor: next }).then(
      (page) => {
        setOlder((prev) => ({ fills: [...(prev?.fills ?? []), ...page.fills], next: page.next }));
        setLoadingMore(false);
      },
      () => setLoadingMore(false),
    );
  }, [trade, next, loadingMore]);

  return {
    fills: [...(first.data?.fills ?? []), ...(older?.fills ?? [])],
    loadingMore,
    hasMore: next !== null,
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
