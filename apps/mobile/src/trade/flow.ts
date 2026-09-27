/**
 * The manual Kuru trade flow (SEN-103, plan M-T21): read → prepare → verify →
 * sign → commit → follow.
 *
 * The device key signs whatever bytes it is handed (`auth/deviceKey.ts`), and
 * every step it is asked to sign was composed by the server. So the ordering
 * below is the security property, not a detail: `verifyKuruTrade` sees ALL of
 * the prepared steps before `sign` is called even once, and any refusal ends
 * the flow with nothing signed. A trade is all-or-nothing on the phone — a
 * signed approve without its verified place would be a standing allowance the
 * user never asked for.
 *
 * Every number that bounds what the user pays is the phone's own:
 * - the trade id is a UUID v4 generated here (it seeds the idempotency keys
 *   and the client order id the verifier checks);
 * - the market facts come from this phone's RPC (`readMarketFacts`), and the
 *   same facts go to the verifier;
 * - a market order's limit is `worstPriceUnits(...)` from those facts and the
 *   user's slippage, and must equal the price the user confirmed on screen —
 *   if the book moved in between, the user reviews again (never a silent
 *   retry at a new price);
 * - the deposit cap is `depositCapAtoms(...)` from the same facts.
 *
 * Following a committed trade never reports a failure it has not seen: a
 * timeout is `pending`, because the steps may well still land.
 *
 * Plain TS, no React Native: `flow.test.ts` runs under plain node.
 */
import { KURU_TESTNET_MARKETS, type KuruMarketConfig } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { NoDeviceKeyError, type Approver } from '../auth/privyApproval.ts';
import { publicClient } from '../chain/client.ts';
import { confirmationDelay } from '../wallet/confirmation.ts';
import { TradeApiError, type TradeApi } from './api.ts';
import {
  depositCapAtoms,
  KuruMarketError,
  readMarketFacts,
  worstPriceUnits,
  type MarketFacts,
} from './kuruMarket.ts';
import type {
  KuruCancelIntent,
  KuruIntent,
  KuruPlaceIntent,
  KuruWithdrawIntent,
  PreparedTrade,
  TradeStatus,
  TradeView,
} from './types.ts';
import { verifyKuruTrade } from './verifyKuru.ts';

/** The three routes the flow uses; a fake in tests, `TradeApi` in the app. */
export type TradeFlowApi = Pick<TradeApi, 'prepare' | 'commit' | 'status'>;

/**
 * What the user confirmed, before the phone fills in its own ids and bounds.
 * For a place, `priceUnits` is the price shown on screen: the limit price, or,
 * for a market order, the worst price computed from the facts the screen read.
 */
export type KuruTradeDraft =
  | Omit<KuruPlaceIntent, 'clientTradeId' | 'maxDepositAtoms'>
  | Omit<KuruCancelIntent, 'clientTradeId'>
  | Omit<KuruWithdrawIntent, 'clientTradeId'>;

export type TradeFlowContext = {
  /** Privy's id for the user's wallet; pins every step's envelope. */
  readonly walletId: string;
  /** The same wallet's address. */
  readonly wallet: Address;
  /** The user's slippage setting. Required for a market order. */
  readonly slippageBps?: number;
};

export type TradeOutcome =
  | { readonly status: 'completed' | 'failed' | 'expired'; readonly view: TradeView }
  /** Still running when the flow stopped following it; `view` is the last one seen. */
  | { readonly status: 'pending'; readonly tradeId: string; readonly view: TradeView | null };

/** What the flow is doing, for a progress screen. Reported in this order. */
export type TradeFlowState =
  | { readonly phase: 'reading_market' }
  | { readonly phase: 'preparing'; readonly intent: KuruIntent }
  | { readonly phase: 'verifying'; readonly prepared: PreparedTrade }
  | { readonly phase: 'signing'; readonly prepared: PreparedTrade }
  | { readonly phase: 'committing'; readonly prepared: PreparedTrade }
  | { readonly phase: 'following'; readonly view: TradeView }
  | { readonly phase: 'settled'; readonly outcome: TradeOutcome };

export type TradeFlowOptions = {
  /** The phone's own market read; defaults to `readMarketFacts` over `publicClient`. */
  readFacts?: (market: KuruMarketConfig) => Promise<MarketFacts>;
  /** Defaults to `crypto.randomUUID` (polyfilled on device, `polyfills.ts`). */
  newClientTradeId?: () => string;
  /** How long to follow a committed trade before answering `pending`. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** The server proposed something the verifier refused; nothing was signed. */
export class TradeApprovalRefusedError extends Error {
  readonly problem: string;
  readonly stepIndex: number | undefined;

  constructor(problem: string, stepIndex?: number) {
    super(
      `This trade doesn’t match what you confirmed, so it wasn’t signed: ${problem}. ` +
        'Nothing was sent.',
    );
    this.name = 'TradeApprovalRefusedError';
    this.problem = problem;
    this.stepIndex = stepIndex;
  }
}

/** The book moved since the user confirmed a market order; nothing was prepared. */
export class TradePriceMovedError extends Error {
  /** The worst price the fresh read allows, for the review screen. */
  readonly worstPriceUnits: bigint;

  constructor(worstPriceUnits: bigint) {
    super('The price moved since you confirmed. Review the order again.');
    this.name = 'TradePriceMovedError';
    this.worstPriceUnits = worstPriceUnits;
  }
}

const DEFAULT_TIMEOUT_MS = 90_000;
const TERMINAL: ReadonlySet<TradeStatus> = new Set(['completed', 'failed', 'expired']);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one manual Kuru trade end to end. Resolves with how it settled (or
 * `pending`); throws before anything is signed for every refusal — local
 * (`TradeApprovalRefusedError`, `TradePriceMovedError`, `NoDeviceKeyError`,
 * `KuruMarketError`) or the API's (`TradeApiError`). `describeTradeError`
 * turns any of them into copy.
 */
export async function runTrade(
  api: TradeFlowApi,
  draft: KuruTradeDraft,
  ctx: TradeFlowContext,
  sign: Approver | null,
  onUpdate: (state: TradeFlowState) => void,
  opts: TradeFlowOptions = {},
): Promise<TradeOutcome> {
  // Checked first, as `sendSponsored` does: no point asking the server to
  // prepare something this session cannot sign.
  if (!sign) throw new NoDeviceKeyError('trading');
  const clientTradeId = (opts.newClientTradeId ?? (() => globalThis.crypto.randomUUID()))();

  let intent: KuruIntent;
  let facts: MarketFacts | undefined;
  if (draft.kind === 'kuru.place') {
    const market = KURU_TESTNET_MARKETS.find(
      (m) => m.address.toLowerCase() === draft.market.toLowerCase(),
    );
    if (market === undefined) {
      throw new TradeApprovalRefusedError(`${draft.market} is not a Kuru market the app trades`);
    }
    onUpdate({ phase: 'reading_market' });
    const readFacts = opts.readFacts ?? ((m) => readMarketFacts(publicClient, m));
    facts = await readFacts(market);
    intent = placeIntent(draft, clientTradeId, market, facts, ctx.slippageBps);
  } else {
    intent = { ...draft, clientTradeId };
  }

  onUpdate({ phase: 'preparing', intent });
  const prepared = await api.prepare(intent);

  onUpdate({ phase: 'verifying', prepared });
  // The verifier pins every step's idempotency key to this id, but the id we
  // commit under comes from the response body; a mismatch is refused outright.
  if (prepared.clientTradeId !== clientTradeId) {
    throw new TradeApprovalRefusedError('the prepared trade is for another trade id');
  }
  const verdict = verifyKuruTrade(prepared.steps, {
    walletId: ctx.walletId,
    wallet: ctx.wallet,
    intent,
    ...(facts !== undefined ? { facts } : {}),
    ...(ctx.slippageBps !== undefined ? { slippageBps: ctx.slippageBps } : {}),
  });
  if (!verdict.ok) throw new TradeApprovalRefusedError(verdict.problem, verdict.stepIndex);

  onUpdate({ phase: 'signing', prepared });
  // Only now, and only the steps that were verified, in step order.
  const signatures = prepared.steps.map((step) => sign(step.payload));

  onUpdate({ phase: 'committing', prepared });
  const outcome = await follow(api, prepared.tradeId, signatures, onUpdate, opts);
  onUpdate({ phase: 'settled', outcome });
  return outcome;
}

/** The full place intent: the phone's id, its worst price and its deposit cap. */
function placeIntent(
  draft: Omit<KuruPlaceIntent, 'clientTradeId' | 'maxDepositAtoms'>,
  clientTradeId: string,
  market: KuruMarketConfig,
  facts: MarketFacts,
  slippageBps: number | undefined,
): KuruPlaceIntent {
  let price: bigint;
  try {
    price = BigInt(draft.priceUnits);
  } catch {
    throw new TradeApprovalRefusedError('the order price is not a price');
  }
  if (draft.orderType === 'market') {
    if (slippageBps === undefined) {
      throw new TradeApprovalRefusedError('no slippage setting to bound the market order');
    }
    const best = draft.side === 'buy' ? facts.bestAsk : facts.bestBid;
    if (best === null) throw new KuruMarketError(`there is no one to ${draft.side} from`);
    const worst = worstPriceUnits(best, slippageBps, facts.params.tickSize, draft.side);
    // The user confirmed a bound computed from an earlier read. Preparing at a
    // new one would trade at a price they never saw, so they review again.
    if (worst !== price) throw new TradePriceMovedError(worst);
  }
  const cap = depositCapAtoms(
    {
      side: draft.side,
      price,
      quantity: BigInt(draft.sizeAtoms),
      tif: draft.orderType === 'market' ? 'ioc' : 'gtc',
    },
    facts.params,
    { quote: market.quote.decimals, base: market.base.decimals },
  );
  return { ...draft, clientTradeId, maxDepositAtoms: cap.toString() };
}

/**
 * Commit, then poll `status` with back-off until the trade is terminal or the
 * deadline passes.
 *
 * A commit that fails without an API answer (network) may or may not have
 * reached the server, and commit is idempotent ("a second commit resends
 * nothing"), so it is retried inside the same loop rather than reported. An
 * API refusal of the commit is final — except `already_terminal`, which means
 * an earlier attempt did land. Status errors are transient until the deadline:
 * the steps are signed and may be executing, so the answer is `pending`, never
 * `failed`.
 */
async function follow(
  api: TradeFlowApi,
  tradeId: string,
  signatures: readonly string[],
  onUpdate: (state: TradeFlowState) => void,
  { timeoutMs = DEFAULT_TIMEOUT_MS, sleep = defaultSleep, now = Date.now }: TradeFlowOptions,
): Promise<TradeOutcome> {
  const deadline = now() + timeoutMs;
  let committed = false;
  let last: TradeView | null = null;

  for (let attempt = 0; attempt === 0 || now() < deadline; attempt += 1) {
    const delay = confirmationDelay(attempt);
    if (delay > 0) await sleep(delay);

    let view: TradeView;
    try {
      view = committed ? await api.status(tradeId) : await api.commit(tradeId, signatures);
      committed = true;
    } catch (error) {
      if (!committed && error instanceof TradeApiError) {
        if (error.reason !== 'already_terminal') throw error;
        committed = true;
      }
      continue;
    }

    last = view;
    onUpdate({ phase: 'following', view });
    if (TERMINAL.has(view.status)) {
      return { status: view.status as 'completed' | 'failed' | 'expired', view };
    }
  }
  return { status: 'pending', tradeId, view: last };
}

export type TradeErrorCopy = { readonly title: string; readonly detail: string };

/**
 * Plain-language copy for anything that stops a trade: the local refusals
 * first, then every `reason` `/trade` refuses with.
 *
 * The refused-here case is not softened, as in `describeSendError`: the server
 * proposed something other than what the user confirmed, and they should read
 * it as that rather than as a network hiccup.
 */
export function describeTradeError(error: unknown): TradeErrorCopy {
  if (error instanceof TradeApprovalRefusedError) {
    return { title: 'This phone refused to sign it', detail: error.message };
  }
  if (error instanceof TradePriceMovedError) {
    return {
      title: 'The price moved',
      detail: 'The book changed since you confirmed. Review the order again. Nothing was sent.',
    };
  }
  if (error instanceof NoDeviceKeyError) return { title: 'Sign in first', detail: error.message };
  if (error instanceof KuruMarketError) {
    return { title: 'This market can’t be traded right now', detail: error.message };
  }
  if (error instanceof TradeApiError) return describeRefusal(error);
  const message = error instanceof Error ? error.message : String(error);
  return { title: 'The trade didn’t go through', detail: message };
}

function describeRefusal(error: TradeApiError): TradeErrorCopy {
  switch (error.reason) {
    case 'trading_disabled':
      return { title: 'Trading is off', detail: 'Manual trading isn’t available right now.' };
    case 'trade_not_found':
      return {
        title: 'This trade is gone',
        detail: 'The server no longer knows this trade. Check your portfolio before retrying.',
      };
    case 'trade_id_conflict':
      return {
        title: 'This trade was already started',
        detail: 'Start the order again from the trade screen.',
      };
    case 'already_terminal':
      return {
        title: 'This trade already finished',
        detail: 'Check your portfolio for the result.',
      };
    case 'trade_expired':
      return {
        title: 'This trade expired',
        detail: 'Prepared trades last a few minutes. Review the order and confirm again.',
      };
    case 'not_supported_yet':
      return { title: 'Not supported yet', detail: 'This kind of trade isn’t available yet.' };
    case 'signature_count_mismatch':
      return {
        title: 'The signatures didn’t match the trade',
        detail: 'Nothing was sent. Review the order and confirm again.',
      };
    case 'invalid_intent':
      return { title: 'Check the order', detail: 'Something in the order isn’t valid.' };
    case 'market_not_allowed':
      return { title: 'That market isn’t available', detail: 'Pick one of the listed markets.' };
    case 'below_min_notional':
      return {
        title: 'The order is too small',
        detail: 'This market has a minimum order value. Increase the size.',
      };
    case 'reserve_balance':
      return {
        title: 'Monad needs 10 MON left in your wallet',
        detail: 'Depositing this much MON would leave less than that. Trade a smaller size.',
      };
    case 'deposit_cap_exceeded':
      return {
        title: 'The order needs more than you confirmed',
        detail: 'Funding it takes a bigger deposit than you agreed to. Review the order again.',
      };
    case 'insufficient_balance':
      return { title: 'Not enough balance', detail: 'Add funds or reduce the size.' };
    default:
      return { title: 'The trade didn’t go through', detail: error.message };
  }
}
