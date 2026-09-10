/**
 * WebSocket plumbing shared by the market-data and trading sockets.
 *
 * Node 22+ and React Native both ship a global `WebSocket` with the same
 * `onopen`/`onmessage`/`onclose` surface, so there is no `ws` dependency; the
 * factory is injectable for tests.
 */
import { MT } from './wire.ts';
export const defaultWebSocket = (url) => new WebSocket(url);
/**
 * The socket went away. For the trading socket this means every request still
 * in flight has an UNKNOWN outcome — it may have executed — so callers must
 * reconcile from a fresh snapshot rather than assume failure.
 */
export class PerplSocketClosedError extends Error {
  code;
  reason;
  constructor(code, reason, context) {
    super(`${context}: socket closed (${code}${reason ? ` ${reason}` : ''})`);
    this.name = 'PerplSocketClosedError';
    this.code = code;
    this.reason = reason;
  }
}
/**
 * One L2 book snapshot, then disconnect.
 *
 * Perpl publishes the order book ONLY on the market-data socket — there is no
 * REST endpoint for it. The market-data server allows 10 requests/min per
 * connection, so a short-lived connection per read is the cheap option for
 * occasional quotes; a strategy that polls should hold a subscription instead.
 */
export function fetchBookSnapshot(
  wsUrl,
  marketId,
  { webSocket = defaultWebSocket, timeoutMs = 10_000 } = {},
) {
  const stream = `order-book@${marketId}`;
  return new Promise((resolve, reject) => {
    const ws = webSocket(`${wsUrl}/ws/v1/market-data`);
    let sid;
    const done = (error, book) => {
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      ws.close(1000);
      if (error) reject(error);
      else resolve(book);
    };
    const timer = setTimeout(
      () => done(new Error(`no ${stream} snapshot within ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.onopen = () =>
      ws.send(JSON.stringify({ mt: MT.SubscriptionRequest, subs: [{ stream, subscribe: true }] }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.mt === MT.SubscriptionResponse) {
        const sub = message.subs?.find((s) => s.stream === stream);
        // Failures are per-subscription: the socket stays open, so check it.
        if (sub?.status && sub.status.code !== 0) {
          done(new Error(`${stream}: ${sub.status.code} ${sub.status.error ?? ''}`.trim()));
          return;
        }
        sid = sub?.sid;
      } else if (message.mt === MT.L2BookSnapshot && (sid === undefined || message.sid === sid)) {
        done(null, message);
      }
    };
    ws.onerror = () => undefined; // `onclose` follows and carries the code
    ws.onclose = (event) => done(new PerplSocketClosedError(event.code, event.reason, stream));
  });
}
