/**
 * The authenticated trading WebSocket: live account state and order entry.
 *
 * Orders on Perpl's API are not transactions the client sends. An `mt: 22`
 * frame asks the exchange to FORWARD the order on-chain and pay its gas, which
 * it does only for accounts that granted `allowOrderForwarding(true)`. So
 * placing an order costs the user nothing in MON, and the outcome arrives
 * asynchronously in three layers:
 *
 *   mt: 3   exactly one per frame — ADMISSION only. `code: 0` means "accepted
 *           for forwarding", not posted and not filled.
 *   mt: 24  order events, matched by `rq`. What actually happened.
 *   mt: 27  position events, when a fill moves a position.
 *
 * `rq` is the idempotency key: strictly increasing per account, seeded from the
 * account's `lfr` (last forwarded request) in the snapshot. A duplicate `rq`
 * executes at most once.
 */
import { MT, ORDER_FAILURE_REASON, ORDER_STATUS, ORDER_STATUS_REASON } from './wire.ts';
import { newNonce, signInFrame } from './signing.ts';
import { PerplSocketClosedError, defaultWebSocket } from './ws.ts';
/** The gateway refused the frame (mt: 3), or the exchange failed the order (st: 7). */
export class PerplOrderRejectedError extends Error {
  rq;
  order;
  constructor(message, rq, order) {
    super(message);
    this.name = 'PerplOrderRejectedError';
    this.rq = rq;
    this.order = order;
  }
}
/** Raised BEFORE sending, so no order is ever wasted on a guaranteed `sr: 34`. */
export class OrderForwardingDisabledError extends Error {
  constructor(accountId) {
    super(
      `Perpl account ${accountId} has order forwarding off; every API order would fail with ` +
        'sr 34. Call allowOrderForwarding(true) on the Exchange from the owning wallet.',
    );
    this.name = 'OrderForwardingDisabledError';
  }
}
export function describeFailure(order) {
  const sr = order.sr !== undefined ? (ORDER_STATUS_REASON[order.sr] ?? `sr ${order.sr}`) : '';
  const fr = order.fr !== undefined ? (ORDER_FAILURE_REASON[order.fr] ?? `fr ${order.fr}`) : '';
  return `Perpl order rq ${order.rq} failed: ${[sr, fr].filter(Boolean).join(' / ') || 'no reason'}`;
}
/** Statuses of an order still working on the book. */
export const OPEN_ORDER_STATUSES = new Set([
  ORDER_STATUS.Pending,
  ORDER_STATUS.Open,
  ORDER_STATUS.PartiallyFilled,
  ORDER_STATUS.Untriggered,
]);
/**
 * How long a failure waits for a contradicting success. Perpl's rule: the
 * first NON-failure event for an `rq` is definitive, and a failure only counts
 * if nothing else arrives — so a failure is not final the instant it lands.
 */
const FAILURE_GRACE_MS = 1_500;
const STATUS_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
export class PerplTradingSocket {
  wsUrl;
  chainId;
  credentials;
  clock;
  webSocket;
  signInTimeoutMs;
  ws = null;
  connecting = null;
  account = null;
  orders = new Map();
  positions = new Map();
  lastRq = 0;
  frameSn = 0;
  heartbeatSn;
  headBlock = 0;
  ping;
  statusWaiters = new Map();
  watchers = new Set();
  constructor(options) {
    this.wsUrl = options.wsUrl;
    this.chainId = options.chainId;
    this.credentials = options.credentials;
    this.clock = options.clock;
    this.webSocket = options.webSocket ?? defaultWebSocket;
    this.signInTimeoutMs = options.signInTimeoutMs ?? 10_000;
  }
  get connected() {
    return this.ws !== null;
  }
  /** Latest block from the heartbeat stream. */
  get head() {
    return this.headBlock;
  }
  /** The wallet's Perpl account, or null when it has none. */
  accountState() {
    return this.account;
  }
  openOrders() {
    return [...this.orders.values()].filter((o) => !o.r && OPEN_ORDER_STATUSES.has(o.st));
  }
  order(oid) {
    return this.orders.get(orderKey({ oid, rq: 0 }));
  }
  openPositions() {
    return [...this.positions.values()];
  }
  /**
   * Opens the socket, signs in with the first frame, and resolves once the
   * wallet, orders and positions snapshots have all arrived — before that the
   * local state would be a lie. Idempotent; reconnects after a drop.
   */
  connect() {
    if (this.ws) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = this.webSocket(`${this.wsUrl}/ws/v1/trading`);
      const pending = new Set([MT.WalletSnapshot, MT.OrdersSnapshot, MT.PositionsSnapshot]);
      const timer = setTimeout(() => {
        reject(new Error(`Perpl trading sign-in: no snapshots within ${this.signInTimeoutMs}ms`));
        ws.close(1000);
      }, this.signInTimeoutMs);
      ws.onopen = () => {
        ws.send(
          JSON.stringify(signInFrame(this.credentials, this.chainId, this.clock.now(), newNonce())),
        );
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        this.handle(message);
        if (pending.delete(message.mt) && pending.size === 0 && !this.ws) {
          clearTimeout(timer);
          this.ws = ws;
          this.ping = setInterval(
            () => ws.send(JSON.stringify({ mt: MT.Ping, t: Date.now() })),
            PING_INTERVAL_MS,
          );
          resolve();
        }
      };
      ws.onerror = () => undefined; // `onclose` follows and carries the code
      ws.onclose = (event) => {
        clearTimeout(timer);
        // 3401 = the sign-in did not verify (bad key or a stale timestamp).
        const error = new PerplSocketClosedError(event.code, event.reason, 'Perpl trading');
        this.teardown(error);
        reject(error);
      };
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  close() {
    const ws = this.ws;
    this.teardown(new PerplSocketClosedError(1000, 'closed by client', 'Perpl trading'));
    ws?.close(1000);
  }
  /**
   * Sends one order request and resolves with the order event that settles it.
   * Rejects with `PerplOrderRejectedError` on a gateway refusal or an exchange
   * failure, and with `PerplSocketClosedError` if the socket drops first — in
   * which case the order MAY have executed.
   */
  async submit(fields, options) {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new Error('Perpl trading socket is not connected');
    const account = this.requireTradableAccount();
    const rq = Math.max(this.lastRq, account.lfr) + 1;
    this.lastRq = rq;
    const sn = ++this.frameSn;
    const matches = options.matches ?? ((order, id) => order.rq === id);
    const outcome = this.watch(
      (order) => order.acc === account.id && matches(order, rq),
      options.settled,
      options.timeoutMs ?? 30_000,
      rq,
    );
    // The outcome can reject while we are still awaiting admission (a dropped
    // socket rejects both at once). Mark it handled now so that is not an
    // unhandled rejection; the caller still receives it via the return below.
    outcome.promise.catch(() => undefined);
    const admitted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(sn);
        reject(new Error(`Perpl sent no admission status for rq ${rq}; its outcome is unknown`));
      }, STATUS_TIMEOUT_MS);
      this.statusWaiters.set(sn, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
    });
    // lb 0: the server substitutes the market's maximum execution window.
    ws.send(JSON.stringify({ mt: MT.OrderRequest, sn, rq, acc: account.id, lb: 0, ...fields }));
    try {
      await admitted;
    } catch (error) {
      outcome.dispose();
      throw error instanceof PerplOrderRejectedError
        ? new PerplOrderRejectedError(error.message, rq)
        : error;
    }
    return outcome.promise;
  }
  requireTradableAccount() {
    const account = this.account;
    if (!account) {
      throw new Error(
        'This wallet has no Perpl account. Run onboarding (approve, createAccount, ' +
          'allowOrderForwarding) from the owning EOA first.',
      );
    }
    if (account.fr) throw new Error(`Perpl account ${account.id} is frozen`);
    if (!account.fw) throw new OrderForwardingDisabledError(account.id);
    return account;
  }
  watch(matches, settled, timeoutMs, rq) {
    let dispose = () => undefined;
    const promise = new Promise((resolve, reject) => {
      let failure;
      let grace;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(grace);
        this.watchers.delete(watcher);
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          failure
            ? new PerplOrderRejectedError(describeFailure(failure), rq, failure)
            : new Error(
                `Perpl rq ${rq} did not settle within ${timeoutMs}ms; its outcome is unknown — ` +
                  'reconcile from getOpenOrders/getPositions',
              ),
        );
      }, timeoutMs);
      const watcher = {
        matches,
        onEvent: (order) => {
          if (order.st === ORDER_STATUS.Failed) {
            if (!failure) {
              failure = order;
              grace = setTimeout(() => {
                finish();
                reject(new PerplOrderRejectedError(describeFailure(order), rq, order));
              }, FAILURE_GRACE_MS);
            }
            return;
          }
          // The first non-failure event is definitive; forget any earlier failure.
          clearTimeout(grace);
          failure = undefined;
          if (settled(order)) {
            finish();
            resolve(order);
          }
        },
        fail: (error) => {
          finish();
          reject(error);
        },
      };
      dispose = finish;
      this.watchers.add(watcher);
    });
    return { promise, dispose: () => dispose() };
  }
  handle(message) {
    switch (message.mt) {
      case MT.WalletSnapshot: {
        const wallet = message;
        this.account = wallet.as?.[0] ?? null;
        if (this.account) this.lastRq = Math.max(this.lastRq, this.account.lfr);
        this.heartbeatSn = wallet.sn;
        break;
      }
      case MT.AccountUpdate: {
        const update = message;
        if (this.account && update.id === this.account.id) {
          this.account = { ...this.account, ...update };
          this.lastRq = Math.max(this.lastRq, this.account.lfr);
        }
        break;
      }
      case MT.OrdersSnapshot:
      case MT.OrdersUpdate: {
        if (message.mt === MT.OrdersSnapshot) this.orders.clear();
        for (const raw of message['d'] ?? []) {
          const key = orderKey(raw);
          const order = { ...this.orders.get(key), ...raw };
          this.orders.set(key, order);
          for (const watcher of [...this.watchers]) {
            if (watcher.matches(order)) watcher.onEvent(order);
          }
        }
        break;
      }
      case MT.PositionsSnapshot:
      case MT.PositionsUpdate: {
        if (message.mt === MT.PositionsSnapshot) this.positions.clear();
        for (const position of message['d'] ?? []) {
          if (position.st === 1) this.positions.set(position.pid, position);
          else this.positions.delete(position.pid);
        }
        break;
      }
      case MT.StatusResponse: {
        const status = message;
        const waiter = status.cid !== undefined ? this.statusWaiters.get(status.cid) : undefined;
        if (!waiter || status.cid === undefined) break;
        this.statusWaiters.delete(status.cid);
        if (status.status.code === 0) waiter.resolve();
        else {
          waiter.reject(
            new PerplOrderRejectedError(
              `Perpl gateway refused the order: ${status.status.code} ${status.status.error ?? ''}`.trim(),
              0,
            ),
          );
        }
        break;
      }
      case MT.Heartbeat: {
        this.headBlock = Number(message['h'] ?? this.headBlock);
        const sn = message.sn;
        // Heartbeat `sn` steps by exactly one per block. A gap means frames were
        // lost, so local state can no longer be trusted: drop and resnapshot.
        if (this.heartbeatSn !== undefined && sn !== undefined && sn !== this.heartbeatSn + 1) {
          const gap = `heartbeat sequence gap ${this.heartbeatSn} -> ${sn}`;
          const ws = this.ws;
          this.teardown(new PerplSocketClosedError(4000, gap, 'Perpl trading'));
          ws?.close(4000, 'sequence gap');
          return;
        }
        this.heartbeatSn = sn;
        break;
      }
      default:
        break;
    }
  }
  teardown(error) {
    clearInterval(this.ping);
    this.ping = undefined;
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
    }
    this.ws = null;
    this.account = null;
    this.heartbeatSn = undefined;
    for (const waiter of this.statusWaiters.values()) waiter.reject(error);
    this.statusWaiters.clear();
    for (const watcher of [...this.watchers]) watcher.fail(error);
  }
}
function orderKey(order) {
  // Failed and not-yet-posted orders have no on-chain id; their rq is unique.
  return order.oid ? `oid:${order.oid}` : `rq:${order.rq}`;
}
