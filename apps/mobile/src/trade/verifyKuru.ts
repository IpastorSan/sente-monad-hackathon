/**
 * Phone Kuru policy verifier (SEN-93, plan M-T10).
 *
 * The device key signs whatever it is handed (`auth/deviceKey.ts`), so this is
 * THE security boundary for manual Kuru trades: the phone signs a prepared
 * trade only if every step passes here. It composes the pieces below it and
 * adds the checks that need the confirmed intent:
 *
 *   envelope (`envelope.ts`, key `sente-trade:<clientTradeId>:<index>`)
 *     → call list (`calls.ts`) → per-call leg (`kuruLegs.ts`)
 *     → leg sequence and values against the intent and the phone's own market
 *       facts (`kuruMarket.ts`).
 *
 * See docs/design/trading/plan-trading.md, Architecture §1 "Phone checks →
 * Kuru values" and §6 "Threat model". Everything is fail-closed: a shape this
 * file does not name is a refusal, never a pass-through. Every number that
 * decides what the user pays (worst price, deposit cap) comes from the phone,
 * so the server can refuse a trade but not widen it.
 *
 * Pure TS: `verifyKuru.test.ts` runs under plain node.
 */
import {
  KURU_TESTNET_MARKETS,
  NATIVE_TOKEN,
  parseOrderId,
  type KuruMarketConfig,
} from '@sente/venues/kuru';
import { isAddressEqual, keccak256, toBytes, type Address } from 'viem';

import { decodeTransactionCalls } from './calls.ts';
import { tradeIdempotencyKey, verifyTradeEnvelope } from './envelope.ts';
import {
  classifyKuruCall,
  KURU_EXEC,
  KURU_SIDE,
  KURU_TIF,
  type KuruLeg,
  type KuruOrder,
} from './kuruLegs.ts';
import { depositCapAtoms, worstPriceUnits, type MarketFacts } from './kuruMarket.ts';
import type {
  KuruCancelIntent,
  KuruIntent,
  KuruPlaceIntent,
  KuruWithdrawIntent,
  PreparedStep,
} from './types.ts';

export type KuruVerifyContext = {
  /** Privy's id for the user's wallet; pins every envelope's URL. */
  readonly walletId: string;
  /** The same wallet's address; the only account a self-call may be. */
  readonly wallet: Address;
  /** What the user confirmed on this phone. */
  readonly intent: KuruIntent;
  /**
   * The phone's own read of `intent.market` (`readMarketFacts`). Required for a
   * place: it sets the tick, the worst price and the deposit cap.
   */
  readonly facts?: MarketFacts;
  /** The user's slippage setting. Required for a market order. */
  readonly slippageBps?: number;
};

export type KuruVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string; readonly stepIndex?: number };

type Leg = KuruLeg & { readonly stepIndex: number };

type Refusal = { readonly ok: false; readonly problem: string; readonly stepIndex?: number };

const refuse = (problem: string, stepIndex?: number): Refusal =>
  stepIndex === undefined ? { ok: false, problem } : { ok: false, problem, stepIndex };

const PASS: KuruVerifyResult = { ok: true };

/** Lowercase or uppercase hex, v4 version nibble, RFC 4122 variant. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Canonical non-negative decimal: no sign, no leading zeros, no exponent. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Checks every step of a prepared Kuru trade against the intent the user
 * confirmed. `{ok: true}` means the phone may sign ALL of `steps`; any
 * refusal means it signs none of them.
 */
export function verifyKuruTrade(
  steps: readonly PreparedStep[],
  ctx: KuruVerifyContext,
): KuruVerifyResult {
  const { intent } = ctx;
  // The id seeds both the idempotency keys and the client order id. A UUID
  // cannot contain ':' (so no key can be forged across the separator) and is
  // never 32-byte hex (so `toClientOrderId` hashes it, as we do below).
  if (typeof intent.clientTradeId !== 'string' || !UUID_V4.test(intent.clientTradeId)) {
    return refuse('the trade id is not a phone-generated UUID');
  }
  if (steps.length === 0) return refuse('the trade has no steps');

  const legs: Leg[] = [];
  for (const [position, step] of steps.entries()) {
    // The index is signed into the idempotency key; a gap or a swap would let
    // the server run steps out of order or drop one under another's key.
    if (step.index !== position) {
      return refuse(`step ${position} claims to be step ${String(step.index)}`, position);
    }
    const stepLegs = decodeStep(step, ctx, intent.clientTradeId);
    if (!stepLegs.ok) return stepLegs;
    legs.push(...stepLegs.legs);
  }

  switch (intent.kind) {
    case 'kuru.place':
      return verifyPlace(legs, intent, ctx);
    case 'kuru.cancel':
      return verifyCancel(legs, intent);
    case 'kuru.withdraw':
      return verifyWithdraw(legs, intent);
    default:
      return refuse('the trade is not a Kuru trade this phone verifies');
  }
}

/** Envelope → calls → legs for one step, plus the step's own label. */
function decodeStep(
  step: PreparedStep,
  ctx: KuruVerifyContext,
  clientTradeId: string,
): { readonly ok: true; readonly legs: Leg[] } | Refusal {
  const at = step.index;
  const envelope = verifyTradeEnvelope(step.payload, {
    walletId: ctx.walletId,
    idempotencyKey: tradeIdempotencyKey(clientTradeId, at),
    rpcMethod: 'eth_sendTransaction',
  });
  if (!envelope.ok) return refuse(envelope.problem, at);

  const decoded = decodeTransactionCalls(envelope.params['transaction'], ctx.wallet);
  if (!decoded.ok) return refuse(decoded.problem, at);

  const legs: Leg[] = [];
  for (const call of decoded.calls) {
    const leg = classifyKuruCall(call);
    if (!leg.ok) return refuse(leg.problem, at);
    legs.push({ ...leg, stepIndex: at });
  }

  // The label is what the progress UI shows; a step that says "approve" while
  // it places an order would misreport what the user is waiting on.
  const expectedKind = decoded.batched ? 'batch' : legs[0]?.kind;
  if (step.kind !== expectedKind) {
    return refuse(`the step is labelled ${step.kind} but it is ${String(expectedKind)}`, at);
  }
  return { ok: true, legs };
}

// ---------------------------------------------------------------------------
// Place: [approve?, deposit?, place], across any number of steps.

function verifyPlace(
  legs: readonly Leg[],
  intent: KuruPlaceIntent,
  ctx: KuruVerifyContext,
): KuruVerifyResult {
  const market = allowedMarket(intent.market);
  if (market === undefined) return refuse(`${intent.market} is not a Kuru market the app trades`);
  const { facts } = ctx;
  if (facts === undefined) return refuse('the phone has not read this market');
  // `readMarketFacts` already refuses a mismatch; checked again so facts read
  // for another market cannot pass as this one's.
  if (
    facts.params.pricePrecision !== market.pricePrecision ||
    facts.params.sizePrecision !== market.sizePrecision
  ) {
    return refuse('the market facts are not for this market');
  }

  const expected = expectedOrder(intent, facts, ctx.slippageBps);
  if (!expected.ok) return expected;

  // Walk the one allowed shape; anything left over or out of place is refused.
  let i = 0;
  const approve = legs[i]?.kind === 'approve' ? legs[i++] : undefined;
  const deposit = legs[i]?.kind === 'deposit' ? legs[i++] : undefined;
  const place = legs[i];
  if (place === undefined || place.kind !== 'place') {
    return refuse(
      place === undefined
        ? 'the trade never places the order'
        : `a ${place.kind} leg is where the order should be`,
      place?.stepIndex,
    );
  }
  i++;
  if (i !== legs.length) {
    return refuse(`the trade adds a ${legs[i]!.kind} leg after the order`, legs[i]!.stepIndex);
  }

  const orderProblem = checkOrder(place, intent, expected.order);
  if (orderProblem) return refuse(orderProblem, place.stepIndex);

  return checkFunding(approve, deposit, intent, market, facts, expected.order);
}

type ExpectedOrder = {
  readonly side: KuruOrder['side'];
  readonly quantity: bigint;
  readonly price: bigint;
  readonly tif: KuruOrder['tif'];
  readonly executionInstruction: KuruOrder['executionInstruction'];
};

/** The one `NativeOrder` the intent allows, with every bound from the phone. */
function expectedOrder(
  intent: KuruPlaceIntent,
  facts: MarketFacts,
  slippageBps: number | undefined,
): { readonly ok: true; readonly order: ExpectedOrder } | Refusal {
  if (intent.side !== 'buy' && intent.side !== 'sell') return refuse('the order has no side');
  const quantity = parseAtoms(intent.sizeAtoms);
  if (quantity === undefined || quantity === 0n) return refuse('the order size is not a size');
  const confirmedPrice = parseAtoms(intent.priceUnits);
  if (confirmedPrice === undefined || confirmedPrice === 0n) {
    return refuse('the order price is not a price');
  }
  const side = intent.side === 'buy' ? KURU_SIDE.buy : KURU_SIDE.sell;

  if (intent.orderType === 'limit') {
    if (confirmedPrice % facts.params.tickSize !== 0n) {
      return refuse('the limit price is not on the market tick');
    }
    return {
      ok: true,
      order: {
        side,
        quantity,
        price: confirmedPrice,
        tif: KURU_TIF.gtc,
        executionInstruction: intent.postOnly === true ? KURU_EXEC.postOnly : KURU_EXEC.none,
      },
    };
  }
  if (intent.orderType !== 'market') return refuse('the order type is unknown');
  // Post-only on an IOC can never fill; the intent is incoherent, not "close enough".
  if (intent.postOnly !== undefined && intent.postOnly !== false) {
    return refuse('a market order cannot be post-only');
  }
  if (slippageBps === undefined) return refuse('no slippage setting to bound the market order');

  // A buy takes asks, a sell takes bids. The worst price is recomputed here
  // from the phone's own read, never the server's, and must equal what the
  // user confirmed: if the book moved since, the user re-confirms.
  const best = intent.side === 'buy' ? facts.bestAsk : facts.bestBid;
  if (best === null) return refuse(`there is no one to ${intent.side} from`);
  let worst: bigint;
  try {
    worst = worstPriceUnits(best, slippageBps, facts.params.tickSize, intent.side);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'the worst price does not compute');
  }
  if (worst !== confirmedPrice) {
    return refuse('the price moved since you confirmed; review the order again');
  }
  return {
    ok: true,
    order: {
      side,
      quantity,
      price: worst,
      tif: KURU_TIF.ioc,
      executionInstruction: KURU_EXEC.none,
    },
  };
}

function checkOrder(
  leg: Extract<Leg, { kind: 'place' }>,
  intent: KuruPlaceIntent,
  expected: ExpectedOrder,
): string | undefined {
  const { order } = leg;
  if (!isAddressEqual(leg.market, intent.market)) return `the order goes to another market`;
  // A non-zero userId acts on another Kuru account through a TRADE grant
  // (docs/kuru.md "userId = 0"); the user only ever trades their own.
  if (leg.userId !== 0n) return `the order acts for Kuru account ${leg.userId}, not yours`;
  if (order.side !== expected.side) return 'the order is on the wrong side';
  if (order.quantity !== expected.quantity) return 'the order size is not the size you confirmed';
  if (BigInt(order.price) !== expected.price) {
    return 'the order price is not the price you confirmed';
  }
  if (order.tif !== expected.tif) {
    return expected.tif === KURU_TIF.ioc
      ? 'the market order could rest on the book'
      : 'the limit order would not rest on the book';
  }
  if (order.executionInstruction !== expected.executionInstruction) {
    return expected.executionInstruction === KURU_EXEC.postOnly
      ? 'the order is not post-only'
      : 'the order is post-only but you did not ask for that';
  }
  // A non-zero minimum would let the order silently cancel its remainder.
  if (order.minSizeAfterBlock !== 0) return 'the order carries a minimum size after the block';
  const clientOrderId = keccak256(toBytes(intent.clientTradeId));
  if (leg.clientOrderId === undefined) return 'the order carries no client order id';
  // The client order id is how fills are attributed to this trade; another
  // one would credit the trade's result to a different order.
  if (leg.clientOrderId.toLowerCase() !== clientOrderId) {
    return 'the order is tagged for another trade';
  }
  return undefined;
}

/** approve == deposit exactly, on the funding token, within the phone's cap. */
function checkFunding(
  approve: Leg | undefined,
  deposit: Leg | undefined,
  intent: KuruPlaceIntent,
  market: KuruMarketConfig,
  facts: MarketFacts,
  order: ExpectedOrder,
): KuruVerifyResult {
  const funding = intent.side === 'buy' ? market.quote : market.base;
  const native = isAddressEqual(funding.address, NATIVE_TOKEN);

  if (deposit === undefined || deposit.kind !== 'deposit') {
    // No deposit means the free balance already covers the order; a lone
    // approval would leave a standing allowance for nothing.
    if (approve !== undefined) return refuse('the approval is not followed by a deposit');
    return PASS;
  }
  const at = deposit.stepIndex;
  if (!isAddressEqual(deposit.token, funding.address)) {
    return refuse(`the deposit is ${deposit.token}, not ${funding.symbol}`, at);
  }

  if (native) {
    // Native MON rides as msg.value; an approval here is for something else.
    if (approve !== undefined) return refuse('a MON deposit needs no approval', approve.stepIndex);
  } else {
    if (approve === undefined || approve.kind !== 'approve') {
      return refuse(`the ${funding.symbol} deposit has no approval`, at);
    }
    if (!isAddressEqual(approve.token, funding.address)) {
      return refuse(
        `the approval is for ${approve.token}, not ${funding.symbol}`,
        approve.stepIndex,
      );
    }
    if (approve.amount !== deposit.amount) {
      return refuse('the approval is not exactly the deposit', approve.stepIndex);
    }
  }

  const maxDeposit = parseAtoms(intent.maxDepositAtoms);
  if (maxDeposit === undefined) return refuse('the deposit cap is not an amount');
  let cap: bigint;
  try {
    cap = depositCapAtoms(
      {
        side: intent.side,
        price: order.price,
        quantity: order.quantity,
        tif: order.tif === KURU_TIF.ioc ? 'ioc' : 'gtc',
      },
      facts.params,
      { quote: market.quote.decimals, base: market.base.decimals },
    );
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'the deposit cap does not compute');
  }
  // Both caps are the phone's own; the intent's may be tighter (it was shown
  // to the user), the recomputed one guards an intent built on stale facts.
  const limit = cap < maxDeposit ? cap : maxDeposit;
  if (deposit.amount > limit) {
    return refuse(`the deposit is more than the order needs (${deposit.amount} > ${limit})`, at);
  }
  return PASS;
}

// ---------------------------------------------------------------------------
// Cancel and withdraw: exactly one leg.

function verifyCancel(legs: readonly Leg[], intent: KuruCancelIntent): KuruVerifyResult {
  if (allowedMarket(intent.market) === undefined) {
    return refuse(`${intent.market} is not a Kuru market the app trades`);
  }
  let slot: number;
  try {
    slot = parseOrderId(intent.orderId).slotIdx;
  } catch {
    return refuse(`"${intent.orderId}" is not a Kuru order id`);
  }
  const only = single(legs, 'cancel');
  if (!only.ok) return only;
  const leg = only.leg;
  if (leg.kind !== 'cancel') return refuse('the step does not cancel', leg.stepIndex);
  if (!isAddressEqual(leg.market, intent.market)) {
    return refuse('the cancel is on another market', leg.stepIndex);
  }
  if (leg.userId !== 0n) {
    return refuse(`the cancel acts for Kuru account ${leg.userId}, not yours`, leg.stepIndex);
  }
  // Slots are reused: any other slot is someone else's resting order of yours.
  if (leg.slots.length !== 1 || leg.slots[0] !== slot) {
    return refuse(`the cancel is for slot ${leg.slots.join(', ')}, not ${slot}`, leg.stepIndex);
  }
  return PASS;
}

function verifyWithdraw(legs: readonly Leg[], intent: KuruWithdrawIntent): KuruVerifyResult {
  const amount = parseAtoms(intent.amountAtoms);
  if (amount === undefined || amount === 0n)
    return refuse('the withdrawal amount is not an amount');
  const only = single(legs, 'withdraw');
  if (!only.ok) return only;
  const leg = only.leg;
  if (leg.kind !== 'withdraw') return refuse('the step does not withdraw', leg.stepIndex);
  if (!isAddressEqual(leg.token, intent.token)) {
    return refuse(`the withdrawal is ${leg.token}, not the token you chose`, leg.stepIndex);
  }
  if (leg.amount !== amount) {
    return refuse('the withdrawal is not the amount you chose', leg.stepIndex);
  }
  return PASS;
}

function single(
  legs: readonly Leg[],
  kind: 'cancel' | 'withdraw',
): { readonly ok: true; readonly leg: Leg } | Refusal {
  const [leg, extra] = legs;
  if (leg === undefined) return refuse(`the trade does not ${kind}`);
  if (extra !== undefined) {
    return refuse(`the ${kind} carries an extra ${extra.kind} leg`, extra.stepIndex);
  }
  return { ok: true, leg };
}

// ---------------------------------------------------------------------------

function allowedMarket(address: unknown): KuruMarketConfig | undefined {
  if (typeof address !== 'string') return undefined;
  return KURU_TESTNET_MARKETS.find((m) => m.address.toLowerCase() === address.toLowerCase());
}

/** A wire amount, strictly: `"010"`, `"1e3"` or `" 1"` is not one. */
function parseAtoms(value: unknown): bigint | undefined {
  return typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : undefined;
}
