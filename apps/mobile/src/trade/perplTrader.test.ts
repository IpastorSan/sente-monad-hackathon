/**
 * Phone Perpl trader tests (SEN-105). Plain node, no device, no network: a fake
 * `fetch` serves `/pub/context` and a fake WebSocket plays the exchange.
 *
 * The acceptance (plan M-T23): sign-in is the first frame, leverage goes out
 * in hundredths, an unbounded order is refused, and every socket is released.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  MT,
  ORDER_STATUS,
  ORDER_TYPE,
  signInCanonical,
  type PerplContext,
  type WebSocketLike,
} from '@sente/venues/perpl';

import { createPerplTrader, PerplTraderError, type PerplTraderOptions } from './perplTrader.ts';

const SECRET = new Uint8Array(32).fill(7);
const PUBLIC = ed25519.getPublicKey(SECRET);
const ACCOUNT = 493;
const LAST_RQ = 40;

/** BTC-PERP: 1 price decimal, 5 size decimals, 20x max, 5% max slippage, mark $100,000. */
function context(): PerplContext {
  return {
    chain: { chain_id: 10143 },
    instances: [
      {
        id: 1,
        address: '0x0',
        collateral_token_id: 7,
        min_account_open_amount: '0',
        min_deposit_amount: '0',
        min_withdraw_amount: '0',
      },
    ],
    tokens: [{ id: 7, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 }],
    markets: [
      {
        id: 16,
        instance_id: 1,
        perpetual_id: 16,
        symbol: 'BTC',
        name: 'BTC',
        size_units: '1',
        order_ttl_blocks: 100,
        order_max_market_slippage_bps: 500,
        order_max_neg_pnl_collat_bps: 0,
        config: {
          is_open: true,
          price_decimals: 1,
          size_decimals: 5,
          min_posting_amount: '0',
          min_settle_amount: '0',
          initial_margin: 2000, // 20x
          maintenance_margin: 2500,
          maker_fee: 100,
          taker_fee: 690,
          recycle_fee: '0',
        },
        state: {
          at: { b: 5, t: 1_700_000_000_000 },
          orl: 999_000,
          mrk: 1_000_000,
          lst: 1_000_100,
          mid: 1_000_050,
          bid: 1_000_000,
          ask: 1_000_100,
        },
      },
    ],
  };
}

type Frame = { mt: number; [field: string]: unknown };

class FakeSocket implements WebSocketLike {
  readonly sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly url: string;
  private readonly exchange: FakeExchange;

  constructor(url: string, exchange: FakeExchange) {
    this.url = url;
    this.exchange = exchange;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    this.exchange.answer(this, frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const onclose = this.onclose;
    setTimeout(() => onclose?.({ code, reason }), 0);
  }

  push(message: object): void {
    setTimeout(() => {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
    }, 0);
  }
}

/** Perpl as the trading socket sees it: snapshots on sign-in, then fills everything. */
class FakeExchange {
  readonly sockets: FakeSocket[] = [];
  fetches = 0;
  /** When false, sign-in gets no snapshots — the socket hangs mid-connect. */
  snapshots = true;
  position: object | null = null;
  /** The most sockets ever open at once. */
  maxLive = 0;

  readonly options: Pick<PerplTraderOptions, 'webSocket' | 'fetchImpl'> = {
    webSocket: (url) => {
      const ws = new FakeSocket(url, this);
      this.sockets.push(ws);
      this.maxLive = Math.max(this.maxLive, this.sockets.filter((s) => !s.closed).length);
      return ws;
    },
    fetchImpl: async () => {
      this.fetches++;
      return new Response(JSON.stringify(context()), {
        headers: { date: new Date().toUTCString() },
      });
    },
  };

  trading(): FakeSocket[] {
    return this.sockets.filter((ws) => ws.url.endsWith('/ws/v1/trading'));
  }

  answer(ws: FakeSocket, frame: Frame): void {
    if (frame.mt === MT.ApiKeySignIn && this.snapshots) {
      ws.push({
        mt: MT.WalletSnapshot,
        sn: 1,
        addr: '0x0',
        as: [{ in: 1, id: ACCOUNT, fr: false, fw: true, ft: 0, lfr: LAST_RQ, b: '0', lb: '0' }],
      });
      ws.push({ mt: MT.OrdersSnapshot, d: [] });
      ws.push({ mt: MT.PositionsSnapshot, d: this.position ? [this.position] : [] });
    } else if (frame.mt === MT.OrderRequest) {
      ws.push({ mt: MT.StatusResponse, cid: frame['sn'], status: { code: 0 } });
      ws.push({
        mt: MT.OrdersUpdate,
        d: [
          {
            at: { t: 2 },
            rq: frame['rq'],
            mkt: frame['mkt'],
            acc: ACCOUNT,
            oid: 900,
            st: ORDER_STATUS.Filled,
            t: frame['t'],
            p: frame['p'],
            os: frame['s'],
            fs: frame['s'],
            fp: frame['p'],
            fl: frame['fl'],
            lv: frame['lv'],
          },
        ],
      });
    }
  }
}

function trader(exchange: FakeExchange) {
  return createPerplTrader({
    credentials: { apiKey: 'key-1', secretKey: SECRET },
    restUrl: 'https://perpl.test/api',
    wsUrl: 'wss://perpl.test',
    ...exchange.options,
  });
}

const BUY = { symbol: 'BTC-PERP', side: 'buy', size: '0.01', maxSlippage: '0.01' } as const;

test('sign-in is the first frame, signed by the trade key; the order follows it', async () => {
  const exchange = new FakeExchange();
  const order = await trader(exchange).placeMarket({ ...BUY, leverage: 5 });

  const [ws] = exchange.trading();
  assert.ok(ws);
  const [signIn, request] = ws.sent;
  assert.equal(signIn?.mt, MT.ApiKeySignIn);
  assert.equal(signIn['api_key'], 'key-1');
  assert.equal(signIn['chain_id'], 10143);
  const signature = Buffer.from(String(signIn['signature']), 'base64url');
  const message = signInCanonical(10143, Number(signIn['timestamp']), String(signIn['nonce']));
  assert.ok(ed25519.verify(signature, utf8ToBytes(message), PUBLIC));

  assert.equal(request?.mt, MT.OrderRequest);
  assert.equal(request['rq'], LAST_RQ + 1);
  assert.equal(order.status, 'filled');
  assert.equal(order.leverage, 5);
});

test('leverage goes out in hundredths', async () => {
  const exchange = new FakeExchange();
  const t = trader(exchange);
  await t.placeMarket({ ...BUY, leverage: 5 });
  await t.placeLimit({ ...BUY, price: '99000', leverage: 2.5 });
  await t.placeMarket({ ...BUY, leverage: 20 }); // exactly the market max
  const lv = exchange.trading().map((ws) => ws.sent.find((f) => f.mt === MT.OrderRequest)?.['lv']);
  assert.deepEqual(lv, [500, 250, 2000]);
});

test('leverage above the market max, or finer than 0.01x, is refused before any socket', async () => {
  const exchange = new FakeExchange();
  const t = trader(exchange);
  await assert.rejects(t.placeMarket({ ...BUY, leverage: 25 }), /above BTC-PERP's maximum of 20x/);
  await assert.rejects(
    t.placeLimit({ ...BUY, price: '99000', leverage: 20.01 }),
    /above BTC-PERP's maximum/,
  );
  await assert.rejects(t.placeMarket({ ...BUY, leverage: 2.555 }), /finer than/);
  await assert.rejects(t.placeMarket({ ...BUY, leverage: 0 }), PerplTraderError);
  await assert.rejects(t.placeMarket({ ...BUY, leverage: Number.NaN }), PerplTraderError);
  assert.equal(exchange.sockets.length, 0);
});

test('an unbounded market order or close is refused before anything is sent', async () => {
  const exchange = new FakeExchange();
  const t = trader(exchange);
  for (const maxSlippage of [undefined, '', '-0.01', '1e-2', 'abc']) {
    const order = { ...BUY, leverage: 5, maxSlippage } as unknown as Parameters<
      typeof t.placeMarket
    >[0];
    await assert.rejects(t.placeMarket(order), /refusing an unbounded market order/);
    await assert.rejects(
      t.closePosition({ symbol: 'BTC-PERP', maxSlippage: maxSlippage as string }),
      /refusing an unbounded market order/,
    );
  }
  assert.equal(exchange.sockets.length, 0);
  assert.equal(exchange.fetches, 0);
});

test('a market order is an IOC bounded at mark ± maxSlippage', async () => {
  const exchange = new FakeExchange();
  await trader(exchange).placeMarket({ ...BUY, leverage: 5 });
  const request = exchange.trading()[0]?.sent[1];
  assert.equal(request?.['t'], ORDER_TYPE.OpenLong);
  assert.equal(request?.['p'], 1_010_000); // $100,000.0 + 1%
});

test('closePosition bounds the close by its own maxSlippage', async () => {
  const exchange = new FakeExchange();
  exchange.position = {
    at: { t: 1 },
    mkt: 16,
    acc: ACCOUNT,
    pid: 7,
    st: 1,
    sd: 1,
    c: '1000000000',
    ep: 1_000_000,
    s: 1_000,
    lv: 500,
  };
  await trader(exchange).closePosition({ symbol: 'BTC-PERP', maxSlippage: '0.02' });
  const request = exchange.trading()[0]?.sent[1];
  assert.equal(request?.['t'], ORDER_TYPE.CloseLong);
  assert.equal(request?.['p'], 980_000); // $100,000.0 − 2%
  assert.equal(request?.['s'], 1_000);
  assert.equal(request?.['lv'], 500); // the position's own leverage
});

test('each action opens its own socket, one at a time, and closes it after', async () => {
  const exchange = new FakeExchange();
  const t = trader(exchange);
  // Concurrent calls: two live sockets would both seed rq from the same lfr.
  await Promise.all([t.positions(), t.openOrders(), t.placeMarket({ ...BUY, leverage: 5 })]);
  const trading = exchange.trading();
  assert.equal(trading.length, 3);
  assert.equal(exchange.maxLive, 1);
  assert.ok(exchange.sockets.every((ws) => ws.closed));
});

test('a failed action still releases its socket', async () => {
  const exchange = new FakeExchange();
  await assert.rejects(
    trader(exchange).cancel({ symbol: 'BTC-PERP', orderId: '12345' }),
    /no order 12345/,
  );
  assert.equal(exchange.trading().length, 1);
  assert.ok(exchange.sockets.every((ws) => ws.closed));
});

test('the trader keeps its own copy of the key: the caller may zero theirs at once', async () => {
  const exchange = new FakeExchange();
  const mine = Uint8Array.from(SECRET);
  const t = createPerplTrader({
    credentials: { apiKey: 'key-1', secretKey: mine },
    restUrl: 'https://perpl.test/api',
    wsUrl: 'wss://perpl.test',
    ...exchange.options,
  });
  mine.fill(0);
  await t.positions();
  const signIn = exchange.trading()[0]?.sent[0];
  const signature = Buffer.from(String(signIn?.['signature']), 'base64url');
  const message = signInCanonical(10143, Number(signIn?.['timestamp']), String(signIn?.['nonce']));
  assert.ok(ed25519.verify(signature, utf8ToBytes(message), PUBLIC));
});

test('release closes a socket still signing in, and every later call refuses', async () => {
  const exchange = new FakeExchange();
  exchange.snapshots = false;
  const t = trader(exchange);
  const pending = t.positions();
  while (exchange.trading()[0]?.sent.length !== 1) await new Promise((r) => setTimeout(r, 1));

  t.release();
  assert.ok(exchange.trading()[0]?.closed);
  await assert.rejects(pending);
  await assert.rejects(t.positions(), /released/);
  await assert.rejects(t.placeMarket({ ...BUY, leverage: 5 }), /released/);
  assert.equal(exchange.trading().length, 1);
});
