/**
 * Market-data hooks (SEN-110, plan U-4): one per `/markets` route, all on the
 * same `usePolling` loop, so every one pauses off-screen and in the background
 * and returns the same `{data, asOf, stale, error, unavailable, refresh}`.
 *
 * Cadences follow how fast each thing moves and how much it costs: the market
 * list is near-static, the book is what a trader watches tick, klines only gain
 * a candle per interval.
 */
import { useEffect, useState } from 'react';

import type {
  Decimal,
  DepthDto,
  KlineInterval,
  KlinesDto,
  MarketsResponseDto,
  QuoteDto,
  TickerDto,
  TickersResponseDto,
  VenueId,
} from '@/markets/api';
import { usePolling, type Polled } from '@/markets/usePolling';
import { useSession } from '@/session';

export type { Polled } from '@/markets/usePolling';

const MARKETS_MS = 60_000;
const TICKERS_MS = 5_000;
const TICKER_MS = 3_000;
const DEPTH_MS = 2_000;
const KLINES_MS = 30_000;
const QUOTE_MS = 5_000;
/** Long enough that typing "1.25" asks once, not four times. */
const QUOTE_DEBOUNCE_MS = 350;

/** `GET /markets` — the merged list of both venues. */
export function useMarkets(): Polled<MarketsResponseDto> {
  const { markets: api } = useSession();
  return usePolling(api ? 'markets' : null, () => api!.markets(), { intervalMs: MARKETS_MS });
}

/** `GET /markets/tickers` — every ticker, or one venue's. */
export function useTickers(venue?: VenueId): Polled<TickersResponseDto> {
  const { markets: api } = useSession();
  return usePolling(api ? `tickers:${venue ?? '*'}` : null, () => api!.tickers(venue), {
    intervalMs: TICKERS_MS,
  });
}

/** `GET /markets/:venue/:symbol/ticker` */
export function useTicker(venue: VenueId, symbol: string): Polled<TickerDto> {
  const { markets: api } = useSession();
  return usePolling(api ? `ticker:${venue}:${symbol}` : null, () => api!.ticker(venue, symbol), {
    intervalMs: TICKER_MS,
  });
}

/**
 * `GET /markets/:venue/:symbol/klines`. With `endTime` set the window is
 * historical and never changes, but it is still polled at the slow cadence
 * rather than special-cased: the cost is one request per 30 s.
 */
export function useKlines(
  venue: VenueId,
  symbol: string,
  interval: KlineInterval,
  options: { limit?: number; endTime?: number } = {},
): Polled<KlinesDto> {
  const { markets: api } = useSession();
  const { limit, endTime } = options;
  return usePolling(
    api ? `klines:${venue}:${symbol}:${interval}:${limit ?? ''}:${endTime ?? ''}` : null,
    () => api!.klines(venue, symbol, { interval, limit, endTime }),
    { intervalMs: KLINES_MS },
  );
}

/** `GET /markets/:venue/:symbol/depth` — `limit` levels a side (API: 1..50, default 20). */
export function useDepth(venue: VenueId, symbol: string, limit?: number): Polled<DepthDto> {
  const { markets: api } = useSession();
  return usePolling(
    api ? `depth:${venue}:${symbol}:${limit ?? ''}` : null,
    () => api!.depth(venue, symbol, limit),
    { intervalMs: DEPTH_MS },
  );
}

export type QuoteInput = { side: 'buy' | 'sell'; size: Decimal; maxSlippage?: Decimal };

/**
 * `GET /markets/:venue/:symbol/quote` for the size being typed into a ticket.
 *
 * The input is debounced so each keystroke does not cost a request, and
 * `null` (or a size that is not a positive decimal) asks nothing: the API
 * would only answer 400 `invalid_size`. While the debounce is pending the
 * previous size's quote is dropped, because a quote for 1.2 shown under 1.25
 * is a wrong number, not a slightly old one. Keeps polling while the size is
 * steady, because the book under it moves.
 */
export function useQuote(
  venue: VenueId,
  symbol: string,
  input: QuoteInput | null,
  debounceMs = QUOTE_DEBOUNCE_MS,
): Polled<QuoteDto> {
  const { markets: api } = useSession();
  const valid = input !== null && POSITIVE_DECIMAL.test(input.size) ? input : null;
  const wanted = valid
    ? `quote:${venue}:${symbol}:${valid.side}:${valid.size}:${valid.maxSlippage ?? ''}`
    : null;

  const [settled, setSettled] = useState<{ key: string; input: QuoteInput } | null>(null);
  useEffect(() => {
    if (wanted === null || valid === null) return;
    const timer = setTimeout(() => setSettled({ key: wanted, input: valid }), debounceMs);
    return () => clearTimeout(timer);
    // Keyed on `wanted`, not `valid`: the string describes the input exactly,
    // and a fresh object each render would restart the debounce forever.
  }, [wanted, debounceMs]);

  const ready = api !== null && settled !== null && settled.key === wanted;
  return usePolling(ready ? wanted : null, () => api!.quote(venue, symbol, settled!.input), {
    intervalMs: QUOTE_MS,
    asOf: (quote) => quote.bookAsOf,
  });
}

/** A size worth quoting: a plain decimal greater than zero. */
const POSITIVE_DECIMAL = /^(?=.*[1-9])\d+(?:\.\d+)?$/;
