/**
 * The trading socket against a scripted fake: sign-in is the first frame, `rq`
 * seeds from `lfr`, admission and outcome are separate, and nothing is sent
 * for an account that would fail with `sr: 34`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as ed from '@noble/ed25519';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { ServerClock, publicKeyOf, signInCanonical } from './signing.ts';
import {
  OrderForwardingDisabledError,
  PerplOrderRejectedError,
  PerplTradingSocket,
} from './trading.ts';
import { PerplSocketClosedError, type WebSocketLike } from './ws.ts';
import type { PerplPosition } from './wire.ts';

const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');

class FakeSocket implements WebSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000, reason = ''): void {
    this.onclose?.({ code, reason });
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

async function connected(account: Record<string, unknown> | null = { fw: true }) {
  let socket: FakeSocket | undefined;
  const clock = new ServerClock(() => 1_789_065_422_000);
  const trading = new PerplTradingSocket({
    wsUrl: 'wss://testnet.perpl.xyz',
    chainId: 10143,
    credentials: { apiKey: 'token', secretKey: SECRET },
    clock,
    webSocket: (url) => (socket = new FakeSocket(url)),
  });
  const ready = trading.connect();
  const ws = socket!;
  ws.onopen?.();
  ws.push({
    mt: 19,
    sn: 100,
    addr: '0xabc',
    as: account
      ? [{ in: 12, id: 493, fr: false, ft: 0, lfr: 41, b: '100000000', lb: '0', ...account }]
      : [],
  });
  ws.push({ mt: 23, sn: 100, d: [] });
  ws.push({ mt: 26, sn: 100, d: [] });
  await ready;
  return { trading, ws };
}

test('sign-in is the first frame, on /ws/v1/trading, and verifies', async () => {
  const { trading, ws } = await connected();
  assert.equal(ws.url, 'wss://testnet.perpl.xyz/ws/v1/trading');
  const frame = ws.sent[0]!;
  assert.equal(frame['mt'], 29);
  assert.equal(frame['chain_id'], 10143);
  assert.equal(frame['api_key'], 'token');
  assert.equal(frame['timestamp'], '1789065422000');
  const canonical = signInCanonical(10143, 1_789_065_422_000, String(frame['nonce']));
  assert.ok(
    ed.verify(
      Buffer.from(String(frame['signature']), 'base64url'),
      utf8ToBytes(canonical),
      publicKeyOf(SECRET),
    ),
  );
  assert.equal(trading.accountState()?.id, 493);
  trading.close();
});

test('submit: rq = lfr + 1, admission then outcome', async () => {
  const { trading, ws } = await connected();
  const result = trading.submit(
    { mkt: 16, t: 1, p: 771_000, s: 100, fl: 4, lv: 500 },
    { settled: (o) => o.st === 4 },
  );
  await new Promise((r) => setImmediate(r));
  const frame = ws.sent[1]!;
  assert.deepEqual(
    { mt: frame['mt'], rq: frame['rq'], acc: frame['acc'], lb: frame['lb'], mkt: frame['mkt'] },
    { mt: 22, rq: 42, acc: 493, lb: 0, mkt: 16 },
  );
  ws.push({ mt: 3, sid: 100, cid: frame['sn'], status: { code: 0, error: '' } });
  ws.push({
    mt: 24,
    d: [{ at: {}, rq: 42, mkt: 16, acc: 493, oid: 7, st: 2, t: 1, os: 100, fl: 4, lv: 500 }],
  });
  ws.push({
    mt: 24,
    d: [
      { at: {}, rq: 42, mkt: 16, acc: 493, oid: 7, st: 4, t: 1, os: 100, fs: 100, fl: 4, lv: 500 },
    ],
  });
  const order = await result;
  assert.equal(order.oid, 7);
  assert.equal(order.fs, 100);

  // The next request keeps increasing even though lfr has not caught up yet.
  const second = trading.submit(
    { mkt: 16, t: 5, oid: 7, s: 0, fl: 0, lv: 0 },
    { settled: () => true },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.sent[2]!['rq'], 43);
  ws.push({ mt: 3, cid: ws.sent[2]!['sn'], status: { code: 0 } });
  ws.push({
    mt: 24,
    d: [{ at: {}, rq: 43, mkt: 16, acc: 493, oid: 7, st: 5, t: 5, os: 0, fl: 0, lv: 0 }],
  });
  await second;
  trading.close();
});

test('a gateway refusal rejects without waiting for an outcome', async () => {
  const { trading, ws } = await connected();
  const result = trading.submit(
    { mkt: 16, t: 1, s: 100, fl: 0, lv: 99_999 },
    { settled: () => true },
  );
  await new Promise((r) => setImmediate(r));
  ws.push({ mt: 3, cid: ws.sent[1]!['sn'], status: { code: 400, error: 'invalid leverage' } });
  await assert.rejects(
    result,
    (e: unknown) => e instanceof PerplOrderRejectedError && /invalid leverage/.test(e.message),
  );
  trading.close();
});

test('an exchange failure names sr and fr', async () => {
  const { trading, ws } = await connected();
  const result = trading.submit({ mkt: 16, t: 1, s: 100, fl: 4, lv: 500 }, { settled: () => true });
  await new Promise((r) => setImmediate(r));
  ws.push({ mt: 3, cid: ws.sent[1]!['sn'], status: { code: 0 } });
  ws.push({
    mt: 24,
    d: [
      {
        at: {},
        rq: 42,
        mkt: 16,
        acc: 493,
        oid: 0,
        st: 7,
        sr: 44,
        fr: 1,
        t: 1,
        os: 100,
        fl: 4,
        lv: 500,
      },
    ],
  });
  await assert.rejects(
    result,
    (e: unknown) =>
      e instanceof PerplOrderRejectedError &&
      /TakerOrderSettlementFailed \/ InsufficientBalance/.test(e.message),
  );
  trading.close();
});

test('forwarding off: refused locally, nothing is sent', async () => {
  const { trading, ws } = await connected({ fw: false });
  await assert.rejects(
    trading.submit({ mkt: 16, t: 1, s: 100, fl: 0, lv: 100 }, { settled: () => true }),
    OrderForwardingDisabledError,
  );
  assert.equal(ws.sent.length, 1); // only the sign-in
  trading.close();
});

test('no Perpl account: a clear error, not a 1011 close', async () => {
  const { trading, ws } = await connected(null);
  await assert.rejects(
    trading.submit({ mkt: 16, t: 1, s: 100, fl: 0, lv: 100 }, { settled: () => true }),
    /no Perpl account/,
  );
  assert.equal(ws.sent.length, 1);
  trading.close();
});

test('a heartbeat gap drops the socket and fails in-flight requests as unknown', async () => {
  const { trading, ws } = await connected();
  ws.push({ mt: 100, sn: 101, h: 101 });
  const result = trading.submit({ mkt: 16, t: 1, s: 100, fl: 4, lv: 500 }, { settled: () => true });
  await new Promise((r) => setImmediate(r));
  ws.push({ mt: 100, sn: 103, h: 103 }); // 102 missing
  await assert.rejects(result, PerplSocketClosedError);
  assert.equal(trading.connected, false);
});

/** Typed against the wire shape, so a field that moves breaks this loudly. */
const positionFrame = (over: Partial<PerplPosition> = {}): PerplPosition => ({
  at: { t: 1_789_065_422_000 },
  mkt: 16,
  acc: 493,
  pid: 7,
  st: 1,
  sd: 1,
  c: '1000000',
  ep: 6_000_000,
  s: 1000,
  lv: 300,
  ...over,
});

test('a closed position never inherits the open frame’s dpnl/fnd (SEN-33)', async () => {
  const { trading, ws } = await connected();
  // The live position had realised 5 so far, and the close is exactly what
  // moves that number: a closing frame that does not carry it must report
  // nothing rather than republish the pre-close figure as the settled one.
  ws.push({ mt: 27, sn: 100, d: [positionFrame({ dpnl: '5000000', fnd: '100000' })] });
  ws.push({ mt: 27, sn: 100, d: [positionFrame({ st: 2 })] });

  const closed = trading.closedPosition(7)!;
  assert.equal(closed.st, 2);
  // The unchanging facts of the position are still merged across.
  assert.equal(closed.ep, 6_000_000);
  assert.equal(closed.dpnl, undefined);
  assert.equal(closed.fnd, undefined);
  trading.close();
});

test('a later closing frame keeps the settled dpnl an earlier one carried', async () => {
  const { trading, ws } = await connected();
  ws.push({ mt: 27, sn: 100, d: [positionFrame()] });
  // The close can arrive in pieces (SEN-20): once the settled figures land
  // they must survive the partial frames that follow them.
  ws.push({ mt: 27, sn: 100, d: [positionFrame({ st: 2, dpnl: '9000000', fnd: '0' })] });
  ws.push({ mt: 27, sn: 100, d: [positionFrame({ st: 2, xp: 3 })] });

  const closed = trading.closedPosition(7)!;
  assert.equal(closed.dpnl, '9000000');
  assert.equal(closed.xp, 3);
  trading.close();
});
