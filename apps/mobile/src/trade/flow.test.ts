/**
 * The manual trade flow (SEN-103, plan M-T21) against a fake API, a fake
 * market read and a recording signer. Plain node, no device, no network.
 *
 * The fake `prepare` composes steps with `@sente/venues/kuru` — the server's
 * own encoders — from the intent the phone sent, so the happy path is what the
 * server really returns. The refusal tests then assert the one property the
 * flow exists for: a trade the verifier refuses is never signed at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cancelOrderCall,
  depositCalls,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  placeOrderCall,
  toClientOrderId,
  type KuruMarketParams,
} from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { NoDeviceKeyError } from '../auth/privyApproval.ts';
import type { Erc7579Call } from '../wallet/batch.ts';
import { TradeApiError } from './api.ts';
import { tradeIdempotencyKey } from './envelope.ts';
import {
  describeTradeError,
  kuruCancelDraft,
  runTrade,
  TradeApprovalRefusedError,
  TradePriceMovedError,
  type KuruTradeDraft,
  type TradeFlowApi,
  type TradeFlowOptions,
  type TradeFlowState,
} from './flow.ts';
import { depositCapAtoms, worstPriceUnits, type MarketFacts } from './kuruMarket.ts';
import type {
  KuruPlaceIntent,
  PreparedStep,
  PreparedTrade,
  TradeIntent,
  TradeRefusalReason,
  TradeStatus,
  TradeView,
} from './types.ts';

const WALLET_ID = 'wallet00000000000000test';
const WALLET = getAddress('0x7777777777777777777777777777777777777777');
const TRADE_ID = 'server-trade-1';
const MON_USDC = KURU_TESTNET_MARKETS[0]!;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PARAMS: KuruMarketParams = {
  pricePrecision: MON_USDC.pricePrecision,
  sizePrecision: MON_USDC.sizePrecision,
  tickSize: 10n,
  minQuoteNotional: 1_000_000n,
  maxQuoteNotional: 10n ** 15n,
  takerFeePps: 3_000n,
  makerFeePps: 1_000n,
};
const FACTS: MarketFacts = { params: PARAMS, bestBid: 3_490_000n, bestAsk: 3_500_000n };
const SLIPPAGE_BPS = 50;
const SIZE = 1_000_000_000n; // 10 MON
const SELL_WORST = worstPriceUnits(3_490_000n, SLIPPAGE_BPS, 10n, 'sell');
const SELL_CAP = depositCapAtoms(
  { side: 'sell', price: SELL_WORST, quantity: SIZE, tif: 'ioc' },
  PARAMS,
  { quote: 6, base: 18 },
);

/** A market sell of 10 MON at the worst price the screen showed. */
const SELL_MARKET: KuruTradeDraft = {
  kind: 'kuru.place',
  market: MON_USDC.address,
  side: 'sell',
  orderType: 'market',
  sizeAtoms: SIZE.toString(),
  priceUnits: SELL_WORST.toString(),
};

const CTX = { walletId: WALLET_ID, wallet: WALLET, slippageBps: SLIPPAGE_BPS };

/** The Privy request the server composes for one single-call step. */
function payload(clientTradeId: string, index: number, call: Erc7579Call): AuthorizationPayload {
  const value = call.value ?? 0n;
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: {
      'privy-app-id': 'app-id-test',
      'privy-idempotency-key': tradeIdempotencyKey(clientTradeId, index),
    },
    body: {
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      params: {
        transaction: {
          to: getAddress(call.to),
          data: call.data ?? '0x',
          ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
          chain_id: 10143,
        },
      },
    },
  };
}

type Tamper = { quantity?: bigint; clientTradeId?: string };

/** What the server prepares for a Kuru sell: deposit the MON, then place. */
function prepareSell(intent: TradeIntent, tamper: Tamper = {}): PreparedTrade {
  assert.equal(intent.kind, 'kuru.place');
  const place = intent as KuruPlaceIntent;
  const calls: Erc7579Call[] = [
    ...depositCalls(
      KURU_TESTNET_CONTRACTS.accountCore,
      KURU_TESTNET_TOKENS.MON,
      BigInt(place.maxDepositAtoms),
    ),
    placeOrderCall(
      place.market as Address,
      {
        side: 1,
        quantity: tamper.quantity ?? BigInt(place.sizeAtoms),
        price: BigInt(place.priceUnits),
        tif: 1,
        executionInstruction: 0,
        minSizeAfterBlock: 0n,
      } as never,
      toClientOrderId(place.clientTradeId),
    ),
  ];
  const kinds = ['deposit', 'place'] as const;
  const steps: PreparedStep[] = calls.map((call, index) => ({
    index,
    kind: kinds[index]!,
    title: kinds[index]!,
    payload: payload(place.clientTradeId, index, call),
  }));
  return {
    tradeId: TRADE_ID,
    clientTradeId: tamper.clientTradeId ?? place.clientTradeId,
    expiresAt: '2026-09-27T12:05:00.000Z',
    wallet: { walletId: WALLET_ID, address: WALLET },
    steps,
    summary: {},
  };
}

function view(status: TradeStatus): TradeView {
  return {
    tradeId: TRADE_ID,
    clientTradeId: 'x',
    kind: 'kuru.place',
    status,
    steps: [],
    updatedAt: '2026-09-27T12:00:00.000Z',
  };
}

type Call = { method: 'prepare' | 'commit' | 'status'; args: unknown[] };

/** A fake API that records every call; `statuses` are answered in order, the last repeating. */
function fakeApi(
  opts: {
    prepare?: (intent: TradeIntent) => PreparedTrade;
    commit?: () => Promise<TradeView>;
    statuses?: (TradeStatus | Error)[];
  } = {},
): TradeFlowApi & { calls: Call[] } {
  const calls: Call[] = [];
  const statuses = opts.statuses ?? ['completed'];
  let polled = 0;
  return {
    calls,
    prepare(intent) {
      calls.push({ method: 'prepare', args: [intent] });
      return Promise.resolve((opts.prepare ?? prepareSell)(intent));
    },
    commit(tradeId, signatures) {
      calls.push({ method: 'commit', args: [tradeId, signatures] });
      return opts.commit ? opts.commit() : Promise.resolve(view('executing'));
    },
    status(tradeId) {
      calls.push({ method: 'status', args: [tradeId] });
      const next = statuses[Math.min(polled++, statuses.length - 1)]!;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(view(next));
    },
  };
}

/** A signer that records what it was asked to sign. */
function recordingSigner() {
  const signed: AuthorizationPayload[] = [];
  const sign = (p: AuthorizationPayload): string => {
    signed.push(p);
    return `c2ln${signed.length}`;
  };
  return { sign, signed };
}

/** A clock that only moves when the flow sleeps, so timeouts need no real time. */
function fakeClock(): Pick<TradeFlowOptions, 'sleep' | 'now'> {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

const withFacts = (facts: MarketFacts = FACTS): TradeFlowOptions => ({
  readFacts: () => Promise.resolve(facts),
  ...fakeClock(),
});

// ---------------------------------------------------------------------------

test('happy path: verifies, signs every step in order, commits, follows to completed', async () => {
  const api = fakeApi({ statuses: ['executing', 'executing', 'completed'] });
  const { sign, signed } = recordingSigner();
  const states: TradeFlowState[] = [];

  const outcome = await runTrade(api, SELL_MARKET, CTX, sign, (s) => states.push(s), withFacts());

  assert.equal(outcome.status, 'completed');
  const [prepare, commit] = api.calls;
  const intent = prepare!.args[0] as KuruPlaceIntent;
  assert.match(intent.clientTradeId, UUID_V4);
  assert.equal(intent.priceUnits, SELL_WORST.toString());
  assert.equal(intent.maxDepositAtoms, SELL_CAP.toString());

  const prepared = prepareSell(intent);
  assert.deepEqual(
    signed,
    prepared.steps.map((s) => s.payload),
  );
  assert.deepEqual(commit!.args, [TRADE_ID, ['c2ln1', 'c2ln2']]);

  const phases = states.map((s) => s.phase);
  assert.deepEqual(phases.slice(0, 5), [
    'reading_market',
    'preparing',
    'verifying',
    'signing',
    'committing',
  ]);
  assert.equal(phases.at(-1), 'settled');
  assert.ok(phases.includes('following'));
});

test('each trade gets a fresh phone-generated UUID v4', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const api = fakeApi();
    await runTrade(api, SELL_MARKET, CTX, recordingSigner().sign, () => {}, withFacts());
    ids.add((api.calls[0]!.args[0] as KuruPlaceIntent).clientTradeId);
  }
  assert.equal(ids.size, 3);
});

test('a refused step signs NOTHING and commits nothing', async () => {
  // Twice the size the user confirmed, in the last step: the deposit step
  // before it is valid on its own and must not be signed either.
  const api = fakeApi({ prepare: (i) => prepareSell(i, { quantity: SIZE * 2n }) });
  const { sign, signed } = recordingSigner();

  await assert.rejects(
    runTrade(api, SELL_MARKET, CTX, sign, () => {}, withFacts()),
    (e: unknown) =>
      e instanceof TradeApprovalRefusedError && /size/.test(e.problem) && e.stepIndex === 1,
  );
  assert.equal(signed.length, 0);
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['prepare'],
  );
});

test('a prepared trade for another trade id is refused before signing', async () => {
  const api = fakeApi({
    prepare: (i) => prepareSell(i, { clientTradeId: '4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f' }),
  });
  const { sign, signed } = recordingSigner();
  await assert.rejects(
    runTrade(api, SELL_MARKET, CTX, sign, () => {}, withFacts()),
    TradeApprovalRefusedError,
  );
  assert.equal(signed.length, 0);
});

test('price moved: a fresh read that changes the worst price stops before prepare', async () => {
  const api = fakeApi();
  const { sign, signed } = recordingSigner();
  const moved: MarketFacts = { ...FACTS, bestBid: 3_400_000n };

  await assert.rejects(
    runTrade(api, SELL_MARKET, CTX, sign, () => {}, withFacts(moved)),
    (e: unknown) =>
      e instanceof TradePriceMovedError &&
      e.worstPriceUnits === worstPriceUnits(3_400_000n, SLIPPAGE_BPS, 10n, 'sell'),
  );
  assert.equal(api.calls.length, 0, 'nothing is prepared at a price the user did not see');
  assert.equal(signed.length, 0);
  assert.equal(describeTradeError(new TradePriceMovedError(1n)).title, 'The price moved');
});

test('no device key: refuses before asking the server for anything', async () => {
  const api = fakeApi();
  await assert.rejects(
    runTrade(api, SELL_MARKET, CTX, null, () => {}, withFacts()),
    NoDeviceKeyError,
  );
  assert.equal(api.calls.length, 0);
});

test('timeout: a trade still executing is pending, never failed', async () => {
  const api = fakeApi({ statuses: ['executing'] });
  const states: TradeFlowState[] = [];

  const outcome = await runTrade(
    api,
    SELL_MARKET,
    CTX,
    recordingSigner().sign,
    (s) => states.push(s),
    { ...withFacts(), timeoutMs: 10_000 },
  );

  assert.equal(outcome.status, 'pending');
  assert.ok(outcome.status === 'pending' && outcome.view?.status === 'executing');
  assert.ok(api.calls.filter((c) => c.method === 'status').length > 1, 'it kept polling');
  assert.deepEqual(states.at(-1), { phase: 'settled', outcome });
});

test('status errors are transient: an unreachable API ends pending, not failed', async () => {
  const api = fakeApi({ statuses: [new Error('network down')] });
  const outcome = await runTrade(api, SELL_MARKET, CTX, recordingSigner().sign, () => {}, {
    ...withFacts(),
    timeoutMs: 5_000,
  });
  assert.equal(outcome.status, 'pending');
});

test('a commit lost to the network is retried (commit is idempotent)', async () => {
  let attempts = 0;
  const api = fakeApi({
    commit: () =>
      ++attempts === 1
        ? Promise.reject(new Error('socket hang up'))
        : Promise.resolve(view('executing')),
    statuses: ['completed'],
  });
  const outcome = await runTrade(
    api,
    SELL_MARKET,
    CTX,
    recordingSigner().sign,
    () => {},
    withFacts(),
  );
  assert.equal(outcome.status, 'completed');
  assert.equal(attempts, 2);
});

test('an API refusal of the commit is thrown, not followed', async () => {
  const api = fakeApi({
    commit: () => Promise.reject(new TradeApiError(410, 'trade_expired', 'expired')),
  });
  await assert.rejects(
    runTrade(api, SELL_MARKET, CTX, recordingSigner().sign, () => {}, withFacts()),
    (e: unknown) => e instanceof TradeApiError && e.reason === 'trade_expired',
  );
  assert.equal(api.calls.filter((c) => c.method === 'status').length, 0);
});

test('a failed trade reports failed', async () => {
  const api = fakeApi({ statuses: ['failed'] });
  const outcome = await runTrade(
    api,
    SELL_MARKET,
    CTX,
    recordingSigner().sign,
    () => {},
    withFacts(),
  );
  assert.equal(outcome.status, 'failed');
});

test('a cancel needs no market read and carries a phone-generated id', async () => {
  // An empty trade is refused by the verifier; what matters here is what was sent.
  const api = fakeApi({
    prepare: (i) => ({
      tradeId: TRADE_ID,
      clientTradeId: i.clientTradeId,
      expiresAt: '2026-09-27T12:05:00.000Z',
      wallet: { walletId: WALLET_ID, address: WALLET },
      steps: [],
      summary: {},
    }),
  });
  let read = false;
  const readFacts = () => {
    read = true;
    return Promise.resolve(FACTS);
  };
  await assert.rejects(
    runTrade(
      api,
      { kind: 'kuru.cancel', market: MON_USDC.address, orderId: '7:1' },
      CTX,
      recordingSigner().sign,
      () => {},
      { readFacts },
    ),
    TradeApprovalRefusedError,
  );
  assert.equal(read, false);
  const sent = api.calls[0]!.args[0] as TradeIntent;
  assert.equal(sent.kind, 'kuru.cancel');
  assert.match(sent.clientTradeId, UUID_V4);
});

/** What the server prepares for a Kuru cancel: one batch cancelling `slot`. */
function prepareCancel(slot: number) {
  return (intent: TradeIntent): PreparedTrade => ({
    tradeId: TRADE_ID,
    clientTradeId: intent.clientTradeId,
    expiresAt: '2026-09-27T12:05:00.000Z',
    wallet: { walletId: WALLET_ID, address: WALLET },
    steps: [
      {
        index: 0,
        kind: 'cancel',
        title: 'cancel',
        payload: payload(intent.clientTradeId, 0, cancelOrderCall(MON_USDC.address, slot)),
      },
    ],
    summary: {},
  });
}

const CANCEL_7 = kuruCancelDraft({ venue: 'kuru', symbol: MON_USDC.symbol, id: '7:23818' })!;

test('a cancel of the confirmed order is verified, signed once and committed (SEN-144)', async () => {
  const api = fakeApi({ prepare: prepareCancel(7) });
  const { sign, signed } = recordingSigner();
  const outcome = await runTrade(api, CANCEL_7, CTX, sign, () => {}, fakeClock());
  assert.equal(outcome.status, 'completed');
  assert.equal(signed.length, 1);
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['prepare', 'commit', 'status'],
  );
});

test('a cancel prepared for another order signs NOTHING and commits nothing (SEN-144)', async () => {
  // Slot 8 is another of the user's resting orders: cancelling it would be
  // a real, unwanted action, so the phone must refuse before signing.
  const api = fakeApi({ prepare: prepareCancel(8) });
  const { sign, signed } = recordingSigner();
  await assert.rejects(
    runTrade(api, CANCEL_7, CTX, sign, () => {}, fakeClock()),
    (e: unknown) => e instanceof TradeApprovalRefusedError && /slot/.test(e.problem),
  );
  assert.equal(signed.length, 0);
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['prepare'],
  );
});

test('kuruCancelDraft takes the market from the phone table, and only for Kuru', () => {
  assert.deepEqual(CANCEL_7, {
    kind: 'kuru.cancel',
    market: MON_USDC.address,
    orderId: '7:23818',
  });
  assert.equal(kuruCancelDraft({ venue: 'perpl', symbol: 'BTC-PERP', id: '1' }), null);
  assert.equal(kuruCancelDraft({ venue: 'kuru', symbol: 'NOPE-USDC', id: '7:1' }), null);
});

// ---------------------------------------------------------------------------
// Copy.

/** Every reason `/trade` refuses with; `satisfies` fails typecheck if one is missing. */
const REASONS = {
  trading_disabled: true,
  trade_not_found: true,
  trade_id_conflict: true,
  already_terminal: true,
  trade_expired: true,
  not_supported_yet: true,
  signature_count_mismatch: true,
  invalid_intent: true,
  market_not_allowed: true,
  below_min_notional: true,
  reserve_balance: true,
  deposit_cap_exceeded: true,
  insufficient_balance: true,
  below_min_account_open: true,
  perpl_already_onboarded: true,
} satisfies Record<TradeRefusalReason, true>;

test('every refusal reason has its own plain copy', () => {
  const generic = describeTradeError(new TradeApiError(500, undefined, 'boom'));
  assert.equal(generic.title, 'The trade didn’t go through');
  assert.equal(generic.detail, 'boom');

  const titles = new Set<string>();
  for (const reason of Object.keys(REASONS)) {
    const copy = describeTradeError(new TradeApiError(400, reason, `raw ${reason}`));
    assert.notEqual(copy.title, generic.title, reason);
    assert.ok(!copy.detail.includes(reason), `${reason} leaks the code into the copy`);
    titles.add(copy.title);
  }
  assert.equal(titles.size, Object.keys(REASONS).length);
});

test('local refusals have their own copy', () => {
  const refused = describeTradeError(new TradeApprovalRefusedError('the order size is wrong', 1));
  assert.equal(refused.title, 'This phone refused to sign it');
  assert.match(refused.detail, /the order size is wrong.*Nothing was sent/);
  assert.equal(describeTradeError(new NoDeviceKeyError('trading')).title, 'Sign in first');
  assert.equal(describeTradeError(new Error('x')).title, 'The trade didn’t go through');
});
