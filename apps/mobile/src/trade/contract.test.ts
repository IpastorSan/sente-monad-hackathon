/**
 * Cross-side trade contract (SEN-125, test audit 2026-09-27 finding #4).
 *
 * The one contract whose drift turns into "the app cannot trade" or "the phone
 * signs what the server chose": what the API prepares must pass the phone's
 * `verifyKuruTrade` exactly when it is what the user confirmed. Every other
 * suite fakes one side of it — `trade.service.spec` mocks the planner, the
 * planner spec decodes with SDK ABIs, and the phone specs rebuild the Privy
 * envelope by hand — so none of them fails when the two sides drift apart.
 *
 * Here both sides are real and share nothing but a fake chain:
 *
 *   phone  `runTrade` → `readMarketFacts` over the fake chain → the phone's own
 *          intent (worst price, deposit cap) → `api.prepare`
 *   server `planKuru` over the same chain → `sponsoredCallTransaction` →
 *          `sponsoredSendBody` → `PrivyClient.authorizationPayload` keyed by
 *          `tradeIdempotencyKey`, exactly as `TradeService.prepare` and
 *          `PrivyUserWalletProvider.prepareSend` compose them
 *   phone  `verifyKuruTrade` → sign every step, or none.
 *
 * WHY HERE, under `node --test`, and not a jest spec in services/api: the
 * API's `tsconfig.json` has `rootDir: ./src`, so a spec importing
 * `apps/mobile/src/*` would break `tsc` there, while the mobile tsconfig has no
 * rootDir and already runs the API's erasable-syntax modules (`.ts`
 * specifiers, no decorators; CLAUDE.md gotcha 10) under type stripping. So the
 * server side enters at the deepest erasable seam. `TradeService` and
 * `PrivyUserWalletProvider` themselves (decorators, extensionless imports) are
 * mirrored in `serverPrepare`, in five lines; `trade.service.spec` pins those
 * five lines to the same builders from the other side.
 *
 * The tamper cases rebuild legs with the same `@sente/venues/kuru` encoders
 * and repack them with the planner's own `packSteps`, so each refusal is
 * caused by the tamper alone; the "kit" test pins that an untampered rebuild
 * is byte-identical to the plan and signs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  depositCalls,
  encodeNativeOrder,
  erc20TransferCall,
  fromUnits,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  NATIVE_TOKEN,
  placeOrderCall,
  precisionDecimals,
  withdrawCall,
  type KuruCall,
  type KuruMarketConfig,
  type KuruToken,
} from '@sente/venues/kuru';
import fc from 'fast-check';
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  maxUint256,
  parseEther,
  toBytes,
  type Address,
  type PublicClient,
} from 'viem';

import { PrivyClient } from '../../../../services/api/src/agents/privy/privy.client.ts';
import { tradeIdempotencyKey } from '../../../../services/api/src/trade/idempotency-key.ts';
import {
  KuruPlanRefusedError,
  packSteps,
  planKuru,
  type KuruPlan,
  type KuruPlanRefusalReason,
  type PlannedStep,
} from '../../../../services/api/src/trade/kuru-planner.ts';
import {
  sponsoredCallTransaction,
  sponsoredSendBody,
  walletRpcPath,
} from '../../../../services/api/src/wallet/send/sponsored-send.ts';
import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import {
  runTrade,
  TradeApprovalRefusedError,
  type KuruTradeDraft,
  type TradeOutcome,
} from './flow.ts';
import { depositCapAtoms, readMarketFacts, worstPriceUnits } from './kuruMarket.ts';
import type { PreparedStep, PreparedTrade, TradeIntent, TradeView } from './types.ts';

const WALLET = getAddress('0x1111111111111111111111111111111111111111');
const WALLET_ID = 'wallet00000000000000test';
const TRADE_ID = '5b0c8f1e-9a3d-4c2b-8e7f-1a2b3c4d5e6f';
const OTHER_TRADE_ID = '0b7a5c4e-2f1d-4c3b-9a8e-7d6c5b4a3f21';
const ATTACKER = getAddress('0xbad0000000000000000000000000000000000bad');
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const SLIPPAGE_BPS = 50;

const market = (symbol: string): KuruMarketConfig =>
  KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol)!;
const MON_USDC = market('MON-USDC');
const WETH_USDC = market('WETH-USDC');
const { USDC, MON } = KURU_TESTNET_TOKENS;

// ---------------------------------------------------------------------------
// The chain both sides read.

type World = {
  readonly market: KuruMarketConfig;
  readonly tickSize: bigint;
  readonly takerFeePps: bigint;
  readonly makerFeePps: bigint;
  readonly minQuoteNotional: bigint;
  readonly bid: bigint;
  readonly ask: bigint;
  /** AccountCore free balance, by lowercase token address. */
  readonly kuruFree: Readonly<Record<string, bigint>>;
  /** The wallet's native MON, in wei. */
  readonly walletMon: bigint;
  readonly accountId: bigint;
  /** What `getOrderId(accountId, slot)` answers, for any slot. */
  readonly liveOrderId: bigint;
};

function world(fields: Partial<World> = {}): World {
  return {
    market: MON_USDC,
    tickSize: 10n,
    takerFeePps: 3_000n,
    makerFeePps: 1_000n,
    minQuoteNotional: 1_000_000n,
    bid: 3_490_000n,
    ask: 3_500_000n,
    kuruFree: {},
    walletMon: parseEther('100'),
    accountId: 63n,
    liveOrderId: 3683n,
    ...fields,
  };
}

/**
 * Answers the reads the planner (via `KuruVenue`) and the phone
 * (`readMarketFacts`) make, by function name. Anything else fails loudly, so
 * a new read on either side shows up here instead of reading a default.
 */
function fakeChain(w: World): PublicClient {
  const readContract = ({
    address,
    functionName,
    args,
  }: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> => {
    switch (functionName) {
      case 'getMarketParams': {
        const m = KURU_TESTNET_MARKETS.find((x) => isAddressEqual(x.address, address))!;
        return Promise.resolve([
          m.pricePrecision,
          m.sizePrecision,
          w.tickSize,
          w.minQuoteNotional,
          10n ** 30n,
          w.takerFeePps,
          w.makerFeePps,
        ]);
      }
      case 'bestBidAsk':
        return Promise.resolve([w.bid, w.ask]);
      case 'getBalance':
        return Promise.resolve(w.kuruFree[(args![1] as Address).toLowerCase()] ?? 0n);
      case 'userRegistry':
        return Promise.resolve(w.accountId);
      case 'getOrderId':
        return Promise.resolve(w.liveOrderId);
      default:
        return Promise.reject(new Error(`fake chain: no ${functionName}`));
    }
  };
  const getBalance = () => Promise.resolve(w.walletMon);
  return { readContract, getBalance } as unknown as PublicClient;
}

// ---------------------------------------------------------------------------
// The server side.

const privy = new PrivyClient({ appId: 'app-id-test', appSecret: 'secret' });

type PlannedLeg = { readonly kind: PlannedStep['kind']; readonly call: KuruCall };
type TamperCtx = { readonly plan: KuruPlan; readonly intent: TradeIntent };
/** Rewrites the plan's legs after planning, before the envelopes are built. */
type LegTamper = (legs: readonly PlannedLeg[], ctx: TamperCtx) => PlannedLeg[];
/** Rewrites the prepared steps after the envelopes are built. */
type StepTamper = (steps: readonly PreparedStep[]) => PreparedStep[];

type Server = { atomic: boolean; legs?: LegTamper; steps?: StepTamper };

/** The legs of a plan in order, whether it was packed into a batch or not. */
function legsOf(plan: KuruPlan): PlannedLeg[] {
  return plan.steps.flatMap((step) => {
    if (step.kind !== 'batch') return [{ kind: step.kind, call: step.calls[0]! }];
    // Only a place is ever batched: [approve?, deposit?, place].
    const kinds = (['approve', 'deposit', 'place'] as const).slice(3 - step.calls.length);
    return step.calls.map((call, i) => ({ kind: kinds[i]!, call }));
  });
}

/** `TradeService.prepare` → `PrivyUserWalletProvider.prepareSend`, per step. */
function envelope(planned: PlannedStep, index: number, clientTradeId: string): PreparedStep {
  const { to, data, value } = planned.transaction;
  const path = walletRpcPath(WALLET_ID);
  const body = sponsoredSendBody(sponsoredCallTransaction(to, data, value));
  const payload = privy.authorizationPayload('POST', path, body, {
    idempotencyKey: tradeIdempotencyKey(clientTradeId, index),
  });
  return { index, kind: planned.kind, title: planned.title, payload };
}

async function serverPrepare(intent: TradeIntent, w: World, server: Server) {
  if (intent.kind === 'perpl.onboard') throw new Error('not a Kuru intent');
  // The phone's intent goes to the planner as-is: this line also pins, at the
  // type level, that the phone's wire type is one the server accepts.
  const deps = { client: fakeChain(w), wallet: WALLET, atomicBatch: server.atomic };
  const plan = await planKuru(intent, deps);
  const planned = server.legs
    ? packSteps(
        server.legs(legsOf(plan), { plan, intent }).map((leg) => ({ ...leg, title: leg.kind })),
        deps,
        'tampered',
      )
    : plan.steps;
  let steps = planned.map((step, index) => envelope(step, index, intent.clientTradeId));
  if (server.steps) steps = server.steps(steps);
  const prepared: PreparedTrade = {
    tradeId: 'server-trade-1',
    clientTradeId: intent.clientTradeId,
    expiresAt: '2026-09-27T12:05:00.000Z',
    wallet: { walletId: WALLET_ID, address: WALLET },
    steps,
    summary: plan.summary,
  };
  return { plan, prepared };
}

// ---------------------------------------------------------------------------
// The phone side: the real flow, with a recording signer.

type Run = {
  readonly outcome?: TradeOutcome;
  readonly error?: unknown;
  readonly plan?: KuruPlan;
  readonly prepared?: PreparedTrade;
  readonly signed: readonly AuthorizationPayload[];
};

const completed: TradeView = {
  tradeId: 'server-trade-1',
  clientTradeId: TRADE_ID,
  kind: 'kuru.place',
  status: 'completed',
  steps: [],
  updatedAt: '2026-09-27T12:00:00.000Z',
};

async function trade(
  draft: KuruTradeDraft,
  w: World,
  server: Server,
  clientTradeId = TRADE_ID,
): Promise<Run> {
  const signed: AuthorizationPayload[] = [];
  let plan: KuruPlan | undefined;
  let prepared: PreparedTrade | undefined;
  const api = {
    prepare: async (intent: TradeIntent) => {
      ({ plan, prepared } = await serverPrepare(intent, w, server));
      return prepared;
    },
    commit: () => Promise.resolve(completed),
    status: () => Promise.resolve(completed),
  };
  const sign = (payload: AuthorizationPayload) => {
    signed.push(payload);
    return `sig${signed.length}`;
  };
  try {
    const outcome = await runTrade(
      api,
      draft,
      { walletId: WALLET_ID, wallet: WALLET, slippageBps: SLIPPAGE_BPS },
      sign,
      () => undefined,
      {
        readFacts: (m) => readMarketFacts(fakeChain(w), m),
        newClientTradeId: () => clientTradeId,
        sleep: () => Promise.resolve(),
      },
    );
    return { outcome, plan, prepared, signed };
  } catch (error) {
    return { error, plan, prepared, signed };
  }
}

/** The phone signed every step the server prepared, byte for byte, and nothing else. */
function assertSigned(run: Run, context: unknown): void {
  const why = JSON.stringify({ context, error: String(run.error) }, bigints);
  assert.equal(run.error, undefined, why);
  assert.equal(run.outcome?.status, 'completed', why);
  assert.deepEqual(
    run.signed,
    run.prepared!.steps.map((s) => s.payload),
    why,
  );
}

/** The phone refused for `reason` and signed nothing at all. */
function assertRefused(run: Run, reason: RegExp): void {
  assert.ok(run.error instanceof TradeApprovalRefusedError, `not refused: ${String(run.error)}`);
  assert.match(run.error.message, reason);
  assert.equal(run.signed.length, 0, 'a refused trade was partly signed');
}

const bigints = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

// ---------------------------------------------------------------------------
// What the user confirms on screen.

type OrderStyle = 'limit' | 'postOnly' | 'market';

/**
 * The draft the order screen would produce: a limit a few ticks inside the
 * book, or the worst price the phone computes from its own read.
 */
async function draftPlace(
  w: World,
  side: 'buy' | 'sell',
  style: OrderStyle,
  sizeAtoms: bigint,
  limitPrice?: bigint,
): Promise<KuruTradeDraft> {
  const facts = await readMarketFacts(fakeChain(w), w.market);
  const price =
    style === 'market'
      ? worstPriceUnits(side === 'buy' ? w.ask : w.bid, SLIPPAGE_BPS, w.tickSize, side)
      : (limitPrice ?? (side === 'buy' ? facts.bestBid! : facts.bestAsk!));
  return {
    kind: 'kuru.place',
    market: w.market.address,
    side,
    orderType: style === 'market' ? 'market' : 'limit',
    ...(style === 'postOnly' ? { postOnly: true } : {}),
    sizeAtoms: sizeAtoms.toString(),
    priceUnits: price.toString(),
  };
}

/** The phone's own deposit cap for a draft: what "fully funded" means. */
function phoneCap(w: World, draft: KuruTradeDraft): bigint {
  assert.equal(draft.kind, 'kuru.place');
  return depositCapAtoms(
    {
      side: draft.side,
      price: BigInt(draft.priceUnits),
      quantity: BigInt(draft.sizeAtoms),
      tif: draft.orderType === 'market' ? 'ioc' : 'gtc',
    },
    { pricePrecision: w.market.pricePrecision, sizePrecision: w.market.sizePrecision, ...fees(w) },
    { quote: w.market.quote.decimals, base: w.market.base.decimals },
  );
}

const fees = (w: World) => ({ takerFeePps: w.takerFeePps, makerFeePps: w.makerFeePps });
const fundingToken = (w: World, side: 'buy' | 'sell'): KuruToken =>
  side === 'buy' ? w.market.quote : w.market.base;
const key = (token: KuruToken) => token.address.toLowerCase();

// ---------------------------------------------------------------------------
// The honest matrix.

const SIZES: Record<string, bigint> = {
  // 10 MON and 0.5 WETH, in each book's size units.
  'MON-USDC': 10n * MON_USDC.sizePrecision,
  'WETH-USDC': WETH_USDC.sizePrecision / 2n,
};
const BOOKS: Record<string, Pick<World, 'bid' | 'ask' | 'tickSize'>> = {
  'MON-USDC': { bid: 3_490_000n, ask: 3_500_000n, tickSize: 10n },
  'WETH-USDC': { bid: 250_000n, ask: 250_100n, tickSize: 5n },
};

for (const m of [MON_USDC, WETH_USDC]) {
  for (const side of ['buy', 'sell'] as const) {
    for (const style of ['limit', 'postOnly', 'market'] as const) {
      for (const funded of [false, true]) {
        for (const atomic of [false, true]) {
          const name =
            `${m.symbol} ${side} ${style}, ${funded ? 'fully funded on Kuru' : 'with a shortfall'}` +
            `, atomic=${atomic}`;
          test(`signs what the server prepares: ${name}`, async () => {
            const base = world({ market: m, ...BOOKS[m.symbol]! });
            const draft = await draftPlace(base, side, style, SIZES[m.symbol]!);
            const cap = phoneCap(base, draft);
            const token = fundingToken(base, side);
            // A shortfall keeps half the reserve free, so the planner has to
            // subtract; "funded" sits exactly on the phone's cap, the edge
            // where a one-atom rounding drift would first show.
            const w = { ...base, kuruFree: { [key(token)]: funded ? cap : cap / 2n } };
            const run = await trade(draft, w, { atomic });
            assertSigned(run, { name, cap, summary: run.plan?.summary });

            const kinds = run.prepared!.steps.map((s) => s.kind);
            const native = isAddressEqual(token.address, NATIVE_TOKEN);
            const legs = funded
              ? ['place']
              : native
                ? ['deposit', 'place']
                : ['approve', 'deposit', 'place'];
            assert.deepEqual(kinds, atomic && legs.length > 1 ? ['batch'] : legs);
            assert.equal(run.plan!.place!.funding.deposit, funded ? 0n : cap - cap / 2n);
          });
        }
      }
    }
  }
}

for (const atomic of [false, true]) {
  test(`signs what the server prepares: cancel, atomic=${atomic}`, async () => {
    const draft: KuruTradeDraft = {
      kind: 'kuru.cancel',
      market: MON_USDC.address,
      orderId: '3:3683',
    };
    const run = await trade(draft, world(), { atomic });
    assertSigned(run, 'cancel');
    assert.deepEqual(
      run.prepared!.steps.map((s) => s.kind),
      ['cancel'],
    );
  });

  for (const token of [USDC, MON]) {
    test(`signs what the server prepares: withdraw ${token.symbol}, atomic=${atomic}`, async () => {
      const amount = 5n * 10n ** BigInt(token.decimals);
      const w = world({ kuruFree: { [key(token)]: amount } });
      const draft: KuruTradeDraft = {
        kind: 'kuru.withdraw',
        token: token.address,
        amountAtoms: amount.toString(),
      };
      const run = await trade(draft, w, { atomic });
      assertSigned(run, 'withdraw');
      assert.deepEqual(
        run.prepared!.steps.map((s) => s.kind),
        ['withdraw'],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Tampered after preparing: every one must be refused, with nothing signed.

type Order = Parameters<typeof placeOrderCall>[1];

/** The plan's order, re-encoded the way the planner encoded it. */
function honestOrder(plan: KuruPlan): Order {
  const place = plan.place!;
  const size = fromUnits(place.quantity, precisionDecimals(place.params.sizePrecision));
  return encodeNativeOrder(
    { side: place.side, price: place.price, size, timeInForce: place.timeInForce },
    place.params,
    place.quoteDecimals,
  );
}

type PlaceEdit = {
  order?: Partial<Order>;
  market?: Address;
  clientTradeId?: string;
  value?: bigint;
};

/** Replace the place leg with one rebuilt from the plan, edited. */
const editPlace =
  (edit: PlaceEdit): LegTamper =>
  (legs, { plan, intent }) =>
    legs.map((leg) => {
      if (leg.kind !== 'place') return leg;
      const call = placeOrderCall(
        edit.market ?? plan.place!.market,
        { ...honestOrder(plan), ...edit.order },
        keccak256(toBytes(edit.clientTradeId ?? intent.clientTradeId)),
      );
      return { kind: 'place', call: edit.value ? { ...call, value: edit.value } : call };
    });

/** Replace the funding legs with a deposit of `amount` of `token` (ERC-20: plus its approval). */
const refund =
  (token: KuruToken, amount: (ctx: TamperCtx) => bigint): LegTamper =>
  (legs, ctx) => {
    const funding = depositCalls(ACCOUNT_CORE, token, amount(ctx));
    const kinds = funding.length === 2 ? (['approve', 'deposit'] as const) : (['deposit'] as const);
    return [
      ...funding.map((call, i) => ({ kind: kinds[i]!, call })),
      ...legs.filter((l) => l.kind === 'place'),
    ];
  };

const deposited = ({ plan }: TamperCtx) => plan.place!.funding.deposit;
const legOf = (legs: readonly PlannedLeg[], kind: PlannedLeg['kind']) =>
  legs.find((l) => l.kind === kind)!;

/** A USDC-funded limit buy with half its reserve already on Kuru: approve, deposit, place. */
async function buyLimitWithShortfall() {
  const w0 = world();
  const draft = await draftPlace(w0, 'buy', 'limit', SIZES['MON-USDC']!);
  const cap = phoneCap(w0, draft);
  return { draft, w: { ...w0, kuruFree: { [key(USDC)]: cap / 2n } }, cap };
}

/** A native-MON market sell with nothing on Kuru: deposit (with value), place. */
async function sellMarketNative() {
  const w = world();
  const draft = await draftPlace(w, 'sell', 'market', SIZES['MON-USDC']!);
  return { draft, w, cap: phoneCap(w, draft) };
}

const PLACE_LEG_TAMPERS: readonly [string, LegTamper, RegExp][] = [
  [
    'the price is one tick worse',
    (legs, ctx) =>
      editPlace({
        order: { price: honestOrder(ctx.plan).price + ctx.plan.place!.params.tickSize },
      })(legs, ctx),
    /not the price you confirmed/,
  ],
  [
    'the size is one unit larger',
    (legs, ctx) => editPlace({ order: { quantity: ctx.plan.place!.quantity + 1n } })(legs, ctx),
    /not the size you confirmed/,
  ],
  ['the side is flipped', editPlace({ order: { side: 'sell' } }), /wrong side/],
  ['the limit order is sent as IOC', editPlace({ order: { tif: 'ioc' } }), /would not rest/],
  [
    'post-only is added',
    editPlace({ order: { executionInstruction: 'postOnly' } }),
    /post-only but you did not ask/,
  ],
  [
    'a minimum size after the block is added',
    editPlace({ order: { minSizeAfterBlock: 1n } }),
    /minimum size after the block/,
  ],
  [
    'the order is tagged for another trade',
    editPlace({ clientTradeId: OTHER_TRADE_ID }),
    /tagged for another trade/,
  ],
  ['the order goes to another market', editPlace({ market: WETH_USDC.address }), /another market/],
  ['the order carries MON', editPlace({ value: 1n }), /carries value/],
  [
    'the deposit is one atom over the phone cap',
    refund(USDC, (ctx) => phoneCapOf(ctx) + 1n),
    /more than the order needs/,
  ],
  [
    'the approval is unlimited',
    (legs) =>
      legs.map((leg) =>
        leg.kind === 'approve'
          ? { kind: 'approve', call: depositCallsApprove(USDC, maxUint256) }
          : leg,
      ),
    /approval is unlimited/,
  ],
  [
    'the deposit is dropped, the approval kept',
    (legs) => legs.filter((l) => l.kind !== 'deposit'),
    /approval is not followed by a deposit/,
  ],
  [
    'the deposit and approval are WETH, not USDC',
    refund(KURU_TESTNET_TOKENS.WETH, deposited),
    /the deposit is 0x[0-9a-fA-F]{40}, not USDC/,
  ],
  [
    'a USDC transfer is appended',
    (legs) => [...legs, { kind: 'place', call: erc20TransferCall(USDC.address, ATTACKER, 1n) }],
    /not a Kuru call the app signs/,
  ],
  [
    'the order is placed before it is funded',
    (legs) => [legOf(legs, 'approve'), legOf(legs, 'place'), legOf(legs, 'deposit')],
    /adds a deposit leg after the order/,
  ],
];

/** The phone cap the tampered trade was confirmed under. */
function phoneCapOf({ intent }: TamperCtx): bigint {
  assert.equal(intent.kind, 'kuru.place');
  return BigInt(intent.maxDepositAtoms);
}

function depositCallsApprove(token: KuruToken, amount: bigint): KuruCall {
  // `depositCalls` refuses nothing about the amount, so its approve leg is the
  // honest encoder at an amount the planner would never choose.
  return depositCalls(ACCOUNT_CORE, token, amount)[0]!;
}

/** `[name, tamper, reason, needsSeparateSteps]`. */
const STEP_TAMPERS: readonly [string, StepTamper, RegExp, boolean][] = [
  [
    'a step is relabelled',
    (steps) => steps.map((s, i) => (i === 0 ? { ...s, kind: 'withdraw' } : s)),
    /labelled withdraw/,
    false,
  ],
  [
    'the place step is dropped',
    (steps) => steps.slice(0, -1),
    /never places the order/,
    // Batched, dropping the only step leaves no trade at all: a different refusal.
    true,
  ],
  [
    'a step is signed under another trade id',
    (steps) =>
      steps.map((s) => ({
        ...s,
        payload: {
          ...s.payload,
          headers: {
            ...s.payload.headers,
            'privy-idempotency-key': tradeIdempotencyKey(OTHER_TRADE_ID, s.index),
          },
        },
      })),
    /idempotency key sente-trade:0b7a5c4e-[^ ]+ is not this step's/,
    false,
  ],
  [
    'a step is sent from another Privy wallet',
    (steps) =>
      steps.map((s) => ({
        ...s,
        payload: { ...s.payload, url: s.payload.url.replace(WALLET_ID, 'wallet-of-someone-else') },
      })),
    /trades from https:\/\/[^ ]+wallet-of-someone-else\/rpc, not from your wallet/,
    false,
  ],
];

for (const atomic of [false, true]) {
  test(`the tamper kit rebuilds the honest plan byte for byte, atomic=${atomic}`, async () => {
    const { draft, w } = await buyLimitWithShortfall();
    // Every place leg rebuilt, the funding re-derived: nothing changed, so it signs.
    const same: LegTamper = (legs, ctx) => refund(USDC, deposited)(editPlace({})(legs, ctx), ctx);
    const run = await trade(draft, w, { atomic, legs: same });
    assertSigned(run, 'no-op tamper');
    const honest = await trade(draft, w, { atomic });
    assert.deepEqual(run.signed, honest.signed);
  });

  for (const [name, tamper, reason] of PLACE_LEG_TAMPERS) {
    test(`refuses a USDC buy when ${name}, atomic=${atomic}`, async () => {
      const { draft, w } = await buyLimitWithShortfall();
      assertRefused(await trade(draft, w, { atomic, legs: tamper }), reason);
    });
  }

  for (const [name, tamper, reason, needsSeparateSteps] of STEP_TAMPERS) {
    if (atomic && needsSeparateSteps) continue;
    test(`refuses a USDC buy when ${name}, atomic=${atomic}`, async () => {
      const { draft, w } = await buyLimitWithShortfall();
      assertRefused(await trade(draft, w, { atomic, steps: tamper }), reason);
    });
  }

  test(`refuses a MON sell whose deposit value differs from its credit, atomic=${atomic}`, async () => {
    const { draft, w } = await sellMarketNative();
    const tamper: LegTamper = (legs) =>
      legs.map((l) =>
        l.kind === 'deposit'
          ? { kind: 'deposit', call: { ...l.call, value: l.call.value! + 1n } }
          : l,
      );
    assertRefused(
      await trade(draft, w, { atomic, legs: tamper }),
      /different value than it credits/,
    );
  });

  test(`refuses a MON sell that also approves USDC, atomic=${atomic}`, async () => {
    const { draft, w } = await sellMarketNative();
    const tamper: LegTamper = (legs, ctx) => [
      { kind: 'approve', call: depositCallsApprove(USDC, deposited(ctx)) },
      ...legs,
    ];
    assertRefused(await trade(draft, w, { atomic, legs: tamper }), /MON deposit needs no approval/);
  });

  test(`refuses a MON sell that deposits more than the phone cap, atomic=${atomic}`, async () => {
    const { draft, w, cap } = await sellMarketNative();
    assertRefused(
      await trade(draft, w, { atomic, legs: refund(MON, () => cap + 1n) }),
      /more than the order needs/,
    );
  });

  const cancel: KuruTradeDraft = {
    kind: 'kuru.cancel',
    market: MON_USDC.address,
    orderId: '3:3683',
  };
  const cancelSlots =
    (market: Address, slots: number[]): LegTamper =>
    () => [
      {
        kind: 'cancel',
        call: {
          to: market,
          value: 0n,
          data: encodeFunctionData({
            abi: KURU_ORDERBOOK_BATCH_ABI,
            functionName: 'batch',
            args: [0, [], slots],
          }),
        },
      },
    ];
  for (const [name, tamper, reason] of [
    ['another slot', cancelSlots(MON_USDC.address, [4]), /the cancel is for slot 4, not 3/],
    ['a second slot too', cancelSlots(MON_USDC.address, [3, 4]), /the cancel is for slot 3, 4/],
    ['the same slot on another market', cancelSlots(WETH_USDC.address, [3]), /another market/],
  ] as const) {
    test(`refuses a cancel of ${name}, atomic=${atomic}`, async () => {
      assertRefused(await trade(cancel, world(), { atomic, legs: tamper }), reason);
    });
  }

  const withdraw: KuruTradeDraft = {
    kind: 'kuru.withdraw',
    token: USDC.address,
    amountAtoms: '5000000',
  };
  for (const [name, tamper, reason] of [
    [
      'more than was chosen',
      () => [{ kind: 'withdraw', call: withdrawCall(ACCOUNT_CORE, USDC, 5_000_001n) }],
      /not the amount you chose/,
    ],
    [
      'another token',
      () => [
        {
          kind: 'withdraw',
          call: withdrawCall(ACCOUNT_CORE, KURU_TESTNET_TOKENS.WETH, 5_000_000n),
        },
      ],
      /the withdrawal is 0x[0-9a-fA-F]{40}, not the token you chose/,
    ],
  ] as const) {
    test(`refuses a withdraw of ${name}, atomic=${atomic}`, async () => {
      const w = world({ kuruFree: { [key(USDC)]: 10_000_000n } });
      assertRefused(await trade(withdraw, w, { atomic, legs: tamper as LegTamper }), reason);
    });
  }
}

// ---------------------------------------------------------------------------
// Properties: the same contract over generated books, sizes and balances.

const PERCENT_FREE = [0n, 1n, 50n, 99n, 100n, 150n] as const;

/** A place on any market the app trades, and the chain state it meets. */
const placeCase = fc.record({
  market: fc.constantFrom(...KURU_TESTNET_MARKETS),
  side: fc.constantFrom('buy' as const, 'sell' as const),
  style: fc.constantFrom('limit' as const, 'postOnly' as const, 'market' as const),
  tickSize: fc.constantFrom(1n, 5n, 10n, 100n),
  takerFeePps: fc.bigInt({ min: 0n, max: 50_000n }),
  makerFeePps: fc.bigInt({ min: 0n, max: 50_000n }),
  // Book prices are uint32: keep the book well below it after slippage.
  bidTicks: fc.bigInt({ min: 1n, max: 2n ** 22n }),
  spreadTicks: fc.bigInt({ min: 1n, max: 100n }),
  limitOffsetTicks: fc.bigInt({ min: -20n, max: 20n }),
  sizeAtoms: fc.bigInt({ min: 1n, max: 10n ** 14n }),
  percentFree: fc.constantFrom(...PERCENT_FREE),
  walletMon: fc.bigInt({ min: 0n, max: parseEther('100000') }),
  atomic: fc.boolean(),
  clientTradeId: fc.uuid({ version: 4 }),
});
type PlaceCase = typeof placeCase extends fc.Arbitrary<infer T> ? T : never;

async function setUp(c: PlaceCase, minQuoteNotional: bigint) {
  const bid = c.bidTicks * c.tickSize;
  const base = world({
    market: c.market,
    tickSize: c.tickSize,
    takerFeePps: c.takerFeePps,
    makerFeePps: c.makerFeePps,
    minQuoteNotional,
    bid,
    ask: bid + c.spreadTicks * c.tickSize,
    walletMon: c.walletMon,
  });
  const limit = (c.side === 'buy' ? bid : base.ask) + c.limitOffsetTicks * c.tickSize;
  const draft = await draftPlace(
    base,
    c.side,
    c.style,
    c.sizeAtoms,
    limit > 0n ? limit : c.tickSize,
  );
  const cap = phoneCap(base, draft);
  const token = fundingToken(base, c.side);
  const w = { ...base, kuruFree: { [key(token)]: (cap * c.percentFree) / 100n } };
  return { w, draft, cap, token };
}

/**
 * The only reasons the planner may refuse an intent the phone built itself.
 * Notably NOT `deposit_cap_exceeded`: the server sizing a deposit above the
 * phone's own cap for the same order is exactly the drift that would make the
 * app unable to trade.
 */
const ACCEPTABLE: ReadonlySet<KuruPlanRefusalReason> = new Set([
  'below_min_notional',
  'reserve_balance',
]);

test('property: any place the phone builds is planned within its cap and signed as prepared', async () => {
  let signedRuns = 0;
  await fc.assert(
    fc.asyncProperty(placeCase, async (c) => {
      const { w, draft, cap, token } = await setUp(c, 1_000_000n);
      const run = await trade(draft, w, { atomic: c.atomic }, c.clientTradeId);
      if (run.error instanceof KuruPlanRefusedError) {
        assert.ok(ACCEPTABLE.has(run.error.reason), `${run.error.reason}: ${run.error.message}`);
        if (run.error.reason === 'reserve_balance') {
          assert.ok(isAddressEqual(token.address, NATIVE_TOKEN), 'reserve refusal on an ERC-20');
        }
        assert.equal(run.signed.length, 0);
        return;
      }
      assertSigned(run, c);
      // Stronger than "within the cap": the server's reserve IS the phone's
      // cap, atom for atom. A server that under-reserves still passes the
      // verifier, but its order fails on chain for want of funds.
      const free = w.kuruFree[key(token)]!;
      assert.equal(run.plan!.place!.funding.deposit, cap > free ? cap - free : 0n);
      signedRuns += 1;
    }),
    { numRuns: 300 },
  );
  // Guards the generator itself: a property that only ever saw refusals
  // would pass while proving nothing.
  assert.ok(signedRuns > 150, `only ${signedRuns} of 300 runs reached the verifier`);
});

/** Single-field tampers of the place leg or its funding, each one a value the user never confirmed. */
const placeTamper = fc.oneof(
  fc
    .bigInt({ min: -5n, max: 5n })
    .filter((k) => k !== 0n)
    .map((k) => ({ field: 'price' as const, k })),
  fc
    .bigInt({ min: -1000n, max: 1000n })
    .filter((k) => k !== 0n)
    .map((k) => ({ field: 'quantity' as const, k })),
  fc.bigInt({ min: 1n, max: 10n ** 18n }).map((k) => ({ field: 'overfund' as const, k })),
  fc.constant({ field: 'side' as const, k: 0n }),
  fc.constant({ field: 'tif' as const, k: 0n }),
  fc.constant({ field: 'postOnly' as const, k: 0n }),
);

test('property: any single-field tamper of a planned place is refused, nothing signed', async () => {
  await fc.assert(
    fc.asyncProperty(placeCase, placeTamper, async (c, t) => {
      // No minimum and a rich wallet: every honest plan exists, so no run is vacuous.
      const { w, draft, cap, token } = await setUp(
        { ...c, walletMon: parseEther('1000000000') },
        0n,
      );
      const tamper: LegTamper = (legs, ctx) => {
        const order = honestOrder(ctx.plan);
        const tick = ctx.plan.place!.params.tickSize;
        switch (t.field) {
          // A move below zero goes the other way instead: still k away, never vacuous.
          case 'price': {
            const price = order.price + t.k * tick;
            return editPlace({ order: { price: price > 0n ? price : order.price - t.k * tick } })(
              legs,
              ctx,
            );
          }
          case 'quantity': {
            const quantity = order.quantity + t.k;
            return editPlace({
              order: { quantity: quantity > 0n ? quantity : order.quantity - t.k },
            })(legs, ctx);
          }
          case 'overfund':
            return refund(token, () => cap + t.k)(legs, ctx);
          case 'side':
            return editPlace({ order: { side: order.side === 'buy' ? 'sell' : 'buy' } })(legs, ctx);
          case 'tif':
            return editPlace({ order: { tif: order.tif === 'ioc' ? 'gtc' : 'ioc' } })(legs, ctx);
          case 'postOnly':
            return editPlace({
              order: {
                executionInstruction:
                  order.executionInstruction === 'postOnly' ? 'none' : 'postOnly',
              },
            })(legs, ctx);
        }
      };
      const run = await trade(draft, w, { atomic: c.atomic, legs: tamper }, c.clientTradeId);
      assert.ok(
        run.error instanceof TradeApprovalRefusedError,
        `${t.field}${t.k} was not refused: ${String(run.error)}`,
      );
      assert.equal(run.signed.length, 0);
    }),
    { numRuns: 300 },
  );
});
