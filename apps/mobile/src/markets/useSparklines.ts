/**
 * 30-day closes for the Markets list's sparklines (SEN-111).
 *
 * Not `useKlines` per row: that is one 30 s poll per market, a dozen loops for
 * lines whose shape changes once a day. Instead each market's daily klines
 * are fetched ONCE when the screen gains focus, all in one parallel batch, and
 * kept in a module cache for `TTL_MS`, so switching tabs back and forth costs
 * nothing. The live end of each line comes from the tickers the list already
 * polls (`sparkPoints` swaps the last close for the live price), so the lines
 * never look frozen next to a moving price.
 *
 * A market whose klines fail, or an API without the route, simply has no
 * line: a sparkline is decoration, never a reason for an error.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { KlineDto, MarketDto } from '@/markets/api';
import { marketKey, type MarketKey } from '@/markets/select';
import { useSession } from '@/session';

const TTL_MS = 15 * 60_000;
const DAYS = 30;

const cache = new Map<MarketKey, { at: number; klines: KlineDto[] }>();

export function useSparklines(
  markets: readonly MarketDto[] | null,
): ReadonlyMap<MarketKey, readonly KlineDto[]> {
  const { markets: api } = useSession();
  const [lines, setLines] = useState<ReadonlyMap<MarketKey, readonly KlineDto[]>>(() => snapshot());
  // The list as a string, so a re-polled but identical `/markets` answer does
  // not re-run the effect.
  const wanted = markets === null ? '' : markets.map(marketKey).join('|');

  useFocusEffect(
    useCallback(() => {
      if (api === null || markets === null) return;
      let cancelled = false;
      const now = Date.now();
      const missing = markets.filter((market) => {
        const hit = cache.get(marketKey(market));
        return hit === undefined || now - hit.at > TTL_MS;
      });
      setLines(snapshot());
      if (missing.length === 0) return;

      void Promise.all(
        missing.map(async (market) => {
          // A failure is cached as "no line" for the same TTL, so an API
          // without the klines route is not asked a dozen times per tab switch.
          const klines = await api
            .klines(market.venue, market.symbol, { interval: '1d', limit: DAYS })
            .then(
              (answer) => answer.klines,
              () => [],
            );
          cache.set(marketKey(market), { at: Date.now(), klines });
        }),
      ).then(() => {
        if (!cancelled) setLines(snapshot());
      });
      return () => {
        cancelled = true;
      };
      // `wanted` stands for `markets` in the deps: see above.
    }, [api, wanted]),
  );

  return lines;
}

function snapshot(): Map<MarketKey, readonly KlineDto[]> {
  return new Map([...cache].map(([key, entry]) => [key, entry.klines]));
}
