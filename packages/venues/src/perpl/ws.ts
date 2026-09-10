/**
 * WebSocket plumbing shared by the market-data and trading sockets.
 *
 * Node 22+ and React Native both ship a global `WebSocket` with the same
 * `onopen`/`onmessage`/`onclose` surface, so there is no `ws` dependency; the
 * factory is injectable for tests.
 */
import { MT, type PerplL2Book } from './wire.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const defaultWebSocket: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * The socket went away. For the trading socket this means every request still
 * in flight has an UNKNOWN outcome — it may have executed — so callers must
 * reconcile from a fresh snapshot rather than assume failure.
 */
export class PerplSocketClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, context: string) {
    super(`${context}: socket closed (${code}${reason ? ` ${reason}` : ''})`);
    this.name = 'PerplSocketClosedError';
    this.code = code;
    this.reason = reason;
  }
}

type MarketDataMessage = {
  mt: number;
  sid?: number;
  subs?: { stream: string; sid?: number; status?: { code: number; error?: string } }[];
};

/**
 * One L2 book snapshot, then disconnect.
 *
 * Perpl publishes the order book ONLY on the market-data socket — there is no
 * REST endpoint for it. The market-data server allows 10 requests/min per
 * connection, so a short-lived connection per read is the cheap option for
 * occasional quotes; a strategy that polls should hold a subscription instead.
 */
export function fetchBookSnapshot(
  wsUrl: string,
  marketId: number,
  {
    webSocket = defaultWebSocket,
    timeoutMs = 10_000,
  }: { webSocket?: WebSocketFactory; timeoutMs?: number } = {},
): Promise<PerplL2Book> {
  const stream = `order-book@${marketId}`;
  return new Promise((resolve, reject) => {
    const ws = webSocket(`${wsUrl}/ws/v1/market-data`);
    let sid: number | undefined;

    const done = (error: Error | null, book?: PerplL2Book) => {
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      ws.close(1000);
      if (error) reject(error);
      else resolve(book as PerplL2Book);
    };
    const timer = setTimeout(
      () => done(new Error(`no ${stream} snapshot within ${timeoutMs}ms`)),
      timeoutMs,
    );

    ws.onopen = () =>
      ws.send(JSON.stringify({ mt: MT.SubscriptionRequest, subs: [{ stream, subscribe: true }] }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as MarketDataMessage;
      if (message.mt === MT.SubscriptionResponse) {
        const sub = message.subs?.find((s) => s.stream === stream);
        // Failures are per-subscription: the socket stays open, so check it.
        if (sub?.status && sub.status.code !== 0) {
          done(new Error(`${stream}: ${sub.status.code} ${sub.status.error ?? ''}`.trim()));
          return;
        }
        sid = sub?.sid;
      } else if (message.mt === MT.L2BookSnapshot && (sid === undefined || message.sid === sid)) {
        done(null, message as unknown as PerplL2Book);
      }
    };
    ws.onerror = () => undefined; // `onclose` follows and carries the code
    ws.onclose = (event) => done(new PerplSocketClosedError(event.code, event.reason, stream));
  });
}
