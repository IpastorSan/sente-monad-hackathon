// Read-only probe of Perpl's PUBLIC market data on testnet (SEN-62, plan B-T1).
//
//   node --no-warnings scripts/perpl-feed-probe.ts [--seconds=120] [--skip-limit]
//
// No credentials, no orders, no funds. It answers the questions PerplBookFeed
// (SEN-64) was built around without evidence:
//
//   (a) after the first `mt:15` snapshot, what arrives: more snapshots, deltas, nothing?
//   (b) does a multi-stream subscribe cost one request against the 10/min, or one per stream?
//   (c) does a market-data socket that never sends a ping get idled out?
//   (d) which REST path serves funding, and what does it return?
//   (e) is `state.orl` the index price that funding uses?
//
// Request volume, on purpose: 6 REST calls, then socket A (1 frame for the whole
// run), then socket B — the only one that exceeds the limit, and exactly once:
// 11 frames, the 11th of which is expected to be refused with a 1008 close.
// `--skip-limit` leaves socket B out.

import {
  MT,
  PERPL_NETWORKS,
  applyL2BookUpdate,
  type PerplContext,
  type PerplL2Book,
} from '../src/perpl/index.ts';

const network = PERPL_NETWORKS.testnet;
const MARKET_DATA = `${network.wsUrl}/ws/v1/market-data`;
const seconds = Number(
  /^--seconds=(\d+)$/.exec(process.argv.find((a) => a.startsWith('--seconds=')) ?? '')?.[1] ?? 120,
);
const skipLimit = process.argv.includes('--skip-limit');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (value: unknown, max = 400) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…(${text.length}B)` : text;
};
const section = (title: string) => console.log(`\n=== ${title} ===`);

async function rest<T>(target: string): Promise<T> {
  const response = await fetch(`${network.restUrl}${target}`);
  const text = await response.text();
  console.log(`GET ${target} -> ${response.status} (${text.length}B)`);
  if (!response.ok) throw new Error(`${target}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

type Frame = { mt: number; sid?: number; sn?: number; [key: string]: unknown };
type FundingEvent = { at: { b?: number; t?: number }; feb: number; rate: number; idx: number };
type MarketWithFunding = PerplContext['markets'][number] & {
  funding?: FundingEvent;
  funding_interval_sec?: number;
};

// --- REST: context, funding, ticker, book (d, e) ----------------------------
section('REST');
const context = await rest<PerplContext>('/v1/pub/context');
const markets = (context.markets as MarketWithFunding[]).filter((m) => m.config.is_open);
console.log(
  `chain ${context.chain.chain_id}, ${markets.length} open of ${context.markets.length} markets`,
);
for (const m of markets) {
  const s = m.state;
  const scale = 10 ** m.config.price_decimals;
  console.log(
    `  #${m.id} ${m.symbol.padEnd(10)} pd=${m.config.price_decimals} orl=${s.orl / scale} mrk=${s.mrk / scale}` +
      ` mid=${s.mid / scale} funding=${clip(m.funding, 200)} interval=${m.funding_interval_sec}s`,
  );
}
const probe = markets[0];
if (!probe) throw new Error('no open market');
const now = Date.now();
const perMarket = await rest<{ at: unknown; m: number; d: FundingEvent[] }>(
  `/v1/market-data/${probe.id}/funding/${now - 86_400_000}-${now}`,
);
console.log(
  `  per-market funding #${probe.id}: ${perMarket.d.length} events, last ${clip(perMarket.d.at(-1))}`,
);
const allMarkets = await rest<{ at: unknown; d: Record<string, FundingEvent[]> }>(
  `/v1/market-data/funding/${now - 3_600_000}-${now}`,
);
console.log(
  `  all-markets funding (1h): keys ${Object.keys(allMarkets.d).join(',')}; #${probe.id} last ${clip(allMarkets.d[probe.id]?.at(-1))}`,
);
const ticker = await rest<Record<string, unknown>>('/v1/market-data/ticker');
console.log(`  ticker: ${clip(ticker, 600)}`);
const restBook = await rest<PerplL2Book>(`/v1/market-data/${probe.id}/book`);
console.log(
  `  REST book #${probe.id}: at ${clip(restBook.at)} ${restBook.bid.length} bids / ${restBook.ask.length} asks, mt=${restBook.mt}`,
);

// --- Socket A: one subscribe for every open market, no pings (a, c) ---------
section(
  `socket A: ${markets.length} order books for ${seconds}s, no client frames after the subscribe`,
);
const byMt = new Map<number, { count: number; bytes: number }>();
const sidToMarket = new Map<number, number>();
const books = new Map<number, PerplL2Book>();
const chain = context.chain.chain_id;
// Latest `mt:9` state per market, to hold `orl`/`mrk` against a funding event's `idx`.
const states = new Map<number, { orl: number; mrk: number; at: { b?: number } }>();
let snIsBlock = 0;
let snNotBlock = 0;
let removals = 0;
let printed = 0;

const closeA = await new Promise<{ code: number; reason: string } | null>((resolve) => {
  const ws = new WebSocket(MARKET_DATA);
  const opened = Date.now();
  // Near the end, two ways to ask again for a stream already held: does either
  // bring a fresh mt:15? PerplBookFeed's stale-book refresh relies on one of them.
  // Found 2026-09-28: a bare re-subscribe is acked with the same sid and NO snapshot.
  const again = (label: string, subs: object[]) => () => {
    console.log(`  ${label} order-book@${probe.id}`);
    ws.send(JSON.stringify({ mt: MT.SubscriptionRequest, subs }));
  };
  const stream = `order-book@${probe.id}`;
  const resubscribes = [
    setTimeout(
      again('re-subscribe', [{ stream, subscribe: true }]),
      Math.max(0, seconds - 10) * 1000,
    ),
    setTimeout(
      again('unsubscribe + subscribe in one frame', [
        { stream, subscribe: false },
        { stream, subscribe: true },
      ]),
      Math.max(0, seconds - 5) * 1000,
    ),
  ];
  const timer = setTimeout(() => {
    resubscribes.forEach(clearTimeout);
    ws.onclose = null;
    ws.close(1000);
    resolve(null);
  }, seconds * 1000);
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        mt: MT.SubscriptionRequest,
        // Still ONE request: market-state and funding ride along for (e).
        subs: [
          ...markets.map((m) => ({ stream: `order-book@${m.id}`, subscribe: true })),
          { stream: `market-state@${chain}`, subscribe: true },
          { stream: `funding@${chain}`, subscribe: true },
        ],
      }),
    );
  ws.onmessage = (event) => {
    const raw = String(event.data);
    const frame = JSON.parse(raw) as Frame;
    const tally = byMt.get(frame.mt) ?? { count: 0, bytes: 0 };
    tally.count += 1;
    tally.bytes += raw.length;
    byMt.set(frame.mt, tally);
    const t = ((Date.now() - opened) / 1000).toFixed(1);

    if (frame.mt === MT.SubscriptionResponse) {
      for (const sub of (frame['subs'] as { stream: string; sid?: number }[]) ?? []) {
        if (sub.sid !== undefined) sidToMarket.set(sub.sid, Number(sub.stream.split('@')[1]));
      }
      console.log(`  +${t}s mt=6 ${clip(frame, 600)}`);
      return;
    }
    const market = frame.sid === undefined ? undefined : sidToMarket.get(frame.sid);
    const at = frame['at'] as { b?: number } | undefined;
    if (frame.sn !== undefined && at?.b !== undefined) {
      if (frame.sn === at.b) snIsBlock += 1;
      else snNotBlock += 1;
    }
    if (frame.mt === 9) {
      const d = frame['d'] as Record<string, { orl: number; mrk: number; at: { b?: number } }>;
      for (const [id, state] of Object.entries(d ?? {})) if (state) states.set(Number(id), state);
    }
    if (frame.mt === 10) {
      // A funding event: is its index what `orl` was saying at the time?
      const d = frame['d'] as Record<string, FundingEvent> | FundingEvent[] | undefined;
      console.log(`  +${t}s mt=10 ${clip(frame, 800)}`);
      for (const [id, event] of Object.entries(d ?? {})) {
        const state = states.get(Number((event as { m?: number }).m ?? id));
        if (state) {
          console.log(
            `    #${id} idx=${event.idx} vs orl=${state.orl} mrk=${state.mrk} (state block ${state.at.b})`,
          );
        }
      }
      return;
    }
    if (frame.mt === MT.L2BookSnapshot && market !== undefined) {
      books.set(market, frame as unknown as PerplL2Book);
    } else if (frame.mt === MT.L2BookUpdate && market !== undefined) {
      const update = frame as unknown as PerplL2Book;
      removals += [...update.bid, ...update.ask].filter((l) => l.o === 0).length;
      const current = books.get(market);
      if (current) books.set(market, applyL2BookUpdate(current, update));
    }
    // Every frame's header; the body only for the first few of each kind.
    const levels = Array.isArray(frame['bid'])
      ? ` bid=${(frame['bid'] as unknown[]).length} ask=${(frame['ask'] as unknown[]).length}`
      : '';
    const body = printed < 12 && frame.mt !== MT.L2BookSnapshot ? ` ${clip(frame, 300)}` : '';
    if (body) printed += 1;
    // Past two minutes only the tallies, funding events and the close matter.
    if ((Date.now() - opened > 120_000 && frame.mt !== MT.L2BookSnapshot) || frame.mt === 9) return;
    console.log(
      `  +${t}s mt=${frame.mt} sid=${frame.sid} sn=${frame.sn} mkt=${market} ${raw.length}B${levels}${body}`,
    );
  };
  ws.onerror = () => undefined;
  ws.onclose = (event) => {
    clearTimeout(timer);
    resubscribes.forEach(clearTimeout);
    resolve({
      code: event.code,
      reason: `${event.reason} after ${((Date.now() - opened) / 1000).toFixed(1)}s`,
    });
  };
});

console.log(`  closed by server: ${closeA ? clip(closeA) : 'no — we closed it at the deadline'}`);
console.log(`  frames by mt: ${clip(Object.fromEntries(byMt))}`);
console.log(
  `  frames whose sn equals at.b: ${snIsBlock} (differs: ${snNotBlock}); levels with o:0 in updates: ${removals}`,
);

// Does the book we maintained from snapshot + updates match a fresh REST book?
const kept = books.get(probe.id);
const fresh = await rest<PerplL2Book>(`/v1/market-data/${probe.id}/book`);
if (kept) {
  const top = (b: PerplL2Book) =>
    clip({ at: b.at, bid: b.bid.slice(0, 3), ask: b.ask.slice(0, 3) });
  console.log(`  maintained #${probe.id}: ${top(kept)}`);
  console.log(`  REST now   #${probe.id}: ${top(fresh)}`);
  // Level by level, over the depth both sides hold: REST may serve fewer levels.
  for (const side of ['bid', 'ask'] as const) {
    const a = kept[side];
    const b = fresh[side];
    const depth = Math.min(a.length, b.length);
    const differ = a
      .slice(0, depth)
      .findIndex((l, i) => JSON.stringify(l) !== JSON.stringify(b[i]));
    console.log(
      `  ${side}: maintained ${a.length} levels, REST ${b.length}; first ${depth} ` +
        (differ < 0
          ? 'identical'
          : `differ at #${differ}: ${clip(a[differ])} vs ${clip(b[differ])}`) +
        ` (blocks ${kept.at.b} vs ${fresh.at.b})`,
    );
  }
}

// --- Socket B: what counts as a request (b) ---------------------------------
if (!skipLimit) {
  section('socket B: 1 frame with every stream, then single-stream frames until refused');
  const streams = markets.map((m) => `order-book@${m.id}`);
  const result = await new Promise<string>((resolve) => {
    const ws = new WebSocket(MARKET_DATA);
    let sent = 0;
    let acks = 0;
    // Does re-subscribing a stream already held send a fresh snapshot? The feed's refresh relies on it.
    let snapshots = 0;
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (frame.mt === MT.SubscriptionResponse) acks += 1;
      if (frame.mt === MT.L2BookSnapshot) snapshots += 1;
    };
    ws.onerror = () => undefined;
    ws.onclose = (event) =>
      resolve(
        `closed ${event.code} "${event.reason}" after ${sent} frames sent (${acks} mt:6 acks, ${snapshots} mt:15)`,
      );
    ws.onopen = async () => {
      // Frame 1 carries every stream: if streams were what counted, this alone
      // would be ${streams.length} of the 10.
      ws.send(
        JSON.stringify({
          mt: MT.SubscriptionRequest,
          subs: streams.map((stream) => ({ stream, subscribe: true })),
        }),
      );
      sent += 1;
      for (; sent < 11;) {
        await sleep(1_000);
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            mt: MT.SubscriptionRequest,
            subs: [{ stream: streams[0], subscribe: true }],
          }),
        );
        sent += 1;
        console.log(`  frame ${sent} sent, ${acks} acks so far`);
      }
      await sleep(3_000);
      ws.close(1000);
      resolve(`NOT refused after ${sent} frames (${acks} acks, ${snapshots} mt:15)`);
    };
  });
  console.log(`  ${result}`);
}
