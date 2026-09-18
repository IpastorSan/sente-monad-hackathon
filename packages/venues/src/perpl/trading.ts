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
import {
  MT,
  ORDER_FAILURE_REASON,
  ORDER_STATUS,
  ORDER_STATUS_REASON,
  type PerplAccount,
  type PerplOrder,
  type PerplPosition,
  type PerplStatusResponse,
  type PerplWalletSnapshot,
} from './wire.ts';
import { newNonce, signInFrame, type PerplCredentials, type ServerClock } from './signing.ts';
import {
  PerplSocketClosedError,
  defaultWebSocket,
  type WebSocketFactory,
  type WebSocketLike,
} from './ws.ts';

export interface TradingSocketOptions {
  /** e.g. `wss://testnet.perpl.xyz`. */
  readonly wsUrl: string;
  readonly chainId: number;
  readonly credentials: PerplCredentials;
  /** Must already be synced to server time: sign-in has a 30s window too. */
  readonly clock: ServerClock;
  readonly webSocket?: WebSocketFactory;
  readonly signInTimeoutMs?: number;
}

/** The caller-chosen fields of an `mt: 22` request. Prices and sizes are scaled integers. */
export interface OrderFields {
  mkt: number;
  t: number;
  s: number;
  fl: number;
  /** Leverage in hundredths: 500 = 5x. */
  lv: number;
  p?: number;
  oid?: number;
  mnp?: number;
}

export interface SubmitOptions {
  /** Which order events answer this request. Defaults to `order.rq === rq`. */
  readonly matches?: (order: PerplOrder, rq: number) => boolean;
  /** When an event is the answer the caller is waiting for. */
  readonly settled: (order: PerplOrder) => boolean;
  readonly timeoutMs?: number;
}

/** The gateway refused the frame (mt: 3), or the exchange failed the order (st: 7). */
export class PerplOrderRejectedError extends Error {
  readonly rq: number;
  readonly order: PerplOrder | undefined;

  constructor(message: string, rq: number, order?: PerplOrder) {
    super(message);
    this.name = 'PerplOrderRejectedError';
    this.rq = rq;
    this.order = order;
  }
}

/** Raised BEFORE sending, so no order is ever wasted on a guaranteed `sr: 34`. */
export class OrderForwardingDisabledError extends Error {
  constructor(accountId: number) {
    super(
      `Perpl account ${accountId} has order forwarding off; every API order would fail with ` +
        'sr 34. Call allowOrderForwarding(true) on the Exchange from the owning wallet.',
    );
    this.name = 'OrderForwardingDisabledError';
  }
}

export function describeFailure(order: PerplOrder): string {
  const sr = order.sr !== undefined ? (ORDER_STATUS_REASON[order.sr] ?? `sr ${order.sr}`) : '';
  const fr = order.fr !== undefined ? (ORDER_FAILURE_REASON[order.fr] ?? `fr ${order.fr}`) : '';
  return `Perpl order rq ${order.rq} failed: ${[sr, fr].filter(Boolean).join(' / ') || 'no reason'}`;
}

/** Statuses of an order still working on the book. */
export const OPEN_ORDER_STATUSES: ReadonlySet<number> = new Set([
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

type Incoming = { mt: number; sn?: number; [field: string]: unknown };

interface OrderWatcher {
  matches(order: PerplOrder): boolean;
  onEvent(order: PerplOrder): void;
  fail(error: Error): void;
}

export class PerplTradingSocket {
  private readonly wsUrl: string;
  private readonly chainId: number;
  private readonly credentials: PerplCredentials;
  private readonly clock: ServerClock;
  private readonly webSocket: WebSocketFactory;
  private readonly signInTimeoutMs: number;

  private ws: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private account: PerplAccount | null = null;
  private readonly orders = new Map<string, PerplOrder>();
  private readonly positions = new Map<number, PerplPosition>();
  /**
   * The last frame of each position that has closed, by pid. A `closePosition`
   * caller reads the settled `dpnl`/`fnd` off it (SEN-20); the live map drops
   * the entry the moment `st` goes non-open.
   */
  private readonly closedPositions = new Map<number, PerplPosition>();
  /** Bound the retained-close map: a long-lived socket must not grow forever. */
  private static readonly MAX_RETAINED_CLOSED = 500;
  private lastRq = 0;
  private frameSn = 0;
  private heartbeatSn: number | undefined;
  private headBlock = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private readonly statusWaiters = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly watchers = new Set<OrderWatcher>();

  constructor(options: TradingSocketOptions) {
    this.wsUrl = options.wsUrl;
    this.chainId = options.chainId;
    this.credentials = options.credentials;
    this.clock = options.clock;
    this.webSocket = options.webSocket ?? defaultWebSocket;
    this.signInTimeoutMs = options.signInTimeoutMs ?? 10_000;
  }

  get connected(): boolean {
    return this.ws !== null;
  }

  /** Latest block from the heartbeat stream. */
  get head(): number {
    return this.headBlock;
  }

  /** The wallet's Perpl account, or null when it has none. */
  accountState(): PerplAccount | null {
    return this.account;
  }

  openOrders(): PerplOrder[] {
    return [...this.orders.values()].filter((o) => !o.r && OPEN_ORDER_STATUSES.has(o.st));
  }

  order(oid: number): PerplOrder | undefined {
    return this.orders.get(orderKey({ oid, rq: 0 }));
  }

  openPositions(): PerplPosition[] {
    return [...this.positions.values()];
  }

  /**
   * The final recorded frame of a position that has closed, by `pid` —
   * `dpnl`/`fnd` included, once their frames have arrived (SEN-20).
   */
  closedPosition(pid: number): PerplPosition | undefined {
    return this.closedPositions.get(pid);
  }

  /**
   * Opens the socket, signs in with the first frame, and resolves once the
   * wallet, orders and positions snapshots have all arrived — before that the
   * local state would be a lie. Idempotent; reconnects after a drop.
   */
  connect(): Promise<void> {
    if (this.ws) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = this.webSocket(`${this.wsUrl}/ws/v1/trading`);
      const pending = new Set<number>([MT.WalletSnapshot, MT.OrdersSnapshot, MT.PositionsSnapshot]);
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
        const message = JSON.parse(String(event.data)) as Incoming;
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

  close(): void {
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
  async submit(fields: OrderFields, options: SubmitOptions): Promise<PerplOrder> {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new Error('Perpl trading socket is not connected');
    const account = this.requireTradableAccount();

    const rq = Math.max(this.lastRq, account.lfr) + 1;
    this.lastRq = rq;
    const sn = ++this.frameSn;
    const matches = options.matches ?? ((order: PerplOrder, id: number) => order.rq === id);
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
    const admitted = new Promise<void>((resolve, reject) => {
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

  private requireTradableAccount(): PerplAccount {
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

  private watch(
    matches: (order: PerplOrder) => boolean,
    settled: (order: PerplOrder) => boolean,
    timeoutMs: number,
    rq: number,
  ): { promise: Promise<PerplOrder>; dispose: () => void } {
    let dispose = () => undefined as void;
    const promise = new Promise<PerplOrder>((resolve, reject) => {
      let failure: PerplOrder | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
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
      const watcher: OrderWatcher = {
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

  private handle(message: Incoming): void {
    switch (message.mt) {
      case MT.WalletSnapshot: {
        const wallet = message as unknown as PerplWalletSnapshot;
        this.account = wallet.as?.[0] ?? null;
        if (this.account) this.lastRq = Math.max(this.lastRq, this.account.lfr);
        this.heartbeatSn = wallet.sn;
        break;
      }
      case MT.AccountUpdate: {
        const update = message as unknown as PerplAccount;
        if (this.account && update.id === this.account.id) {
          this.account = { ...this.account, ...update };
          this.lastRq = Math.max(this.lastRq, this.account.lfr);
        }
        break;
      }
      case MT.OrdersSnapshot:
      case MT.OrdersUpdate: {
        if (message.mt === MT.OrdersSnapshot) this.orders.clear();
        for (const raw of (message['d'] as PerplOrder[] | undefined) ?? []) {
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
        for (const position of (message['d'] as PerplPosition[] | undefined) ?? []) {
          if (position.st === 1) this.positions.set(position.pid, position);
          else {
            // Record the frame that closed it, merged with the last known
            // one: a closePosition caller wants the settled dpnl/fnd the
            // live map no longer holds, and updates can be partial (SEN-20).
            //
            // The ACCRUING fields are the exception, and they are the whole
            // point of retaining the frame (SEN-33): `dpnl`, `fnd` and `fee`
            // are exactly what the close MOVES, so an open frame's values are
            // stale by construction and merging them would publish a pre-close
            // figure as the settled realised PnL. Only an already-closed frame
            // may fill them in — the close itself can arrive in several partial
            // updates, and the later ones need the settled figures the first
            // one carried.
            const retained = this.closedPositions.get(position.pid);
            const live = this.positions.get(position.pid);
            this.positions.delete(position.pid);
            const known = retained ?? (live && stripAccrued(live));
            if (
              retained === undefined &&
              this.closedPositions.size >= PerplTradingSocket.MAX_RETAINED_CLOSED
            ) {
              // Oldest first: Map iteration order is insertion order.
              const oldest = this.closedPositions.keys().next();
              if (!oldest.done) this.closedPositions.delete(oldest.value);
            }
            this.closedPositions.set(position.pid, { ...known, ...position });
          }
        }
        break;
      }
      case MT.StatusResponse: {
        const status = message as unknown as PerplStatusResponse;
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

  private teardown(error: Error): void {
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

/**
 * A position frame with the figures that ACCRUE removed (SEN-33).
 *
 * `dpnl`, `fnd` and `fee` are cumulative up to the frame that carries them, and
 * the close is exactly what moves them. Merging an OPEN frame into a closing
 * one must therefore not carry them across: `withClosePnl` would publish that
 * pre-close number as the position's settled realised PnL, and a caller has no
 * way to tell it from the real one. Absent is honest; stale is not. What is
 * left — the position's identity, side, entry and leverage — does not change
 * over its life, which is what makes the merge safe for those.
 */
function stripAccrued(position: PerplPosition): PerplPosition {
  const { dpnl: _dpnl, fnd: _fnd, fee: _fee, ...rest } = position;
  return rest;
}

function orderKey(order: Pick<PerplOrder, 'oid' | 'rq'>): string {
  // Failed and not-yet-posted orders have no on-chain id; their rq is unique.
  return order.oid ? `oid:${order.oid}` : `rq:${order.rq}`;
}
