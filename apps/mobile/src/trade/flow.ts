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
 * - the deposit cap is `depositCapAtoms(...)` from the same facts, with this
 *   build's Sente fee pin (`kuruBuilder.ts`, SEN-184) as extra headroom;
 * - the Sente fee the order may pay is that pin, never the server's.
 *
 * Following a committed trade never reports a failure it has not seen: a
 * timeout is `pending`, because the steps may well still land.
 *
 * Perpl setup (SEN-104) follows the same rule: `runPerplOnboard` runs
 * `verifyPerplOnboard` over every step before the first signature, and
 * `runPerplEnrollment` runs `verifyEnrollmentPrepare` over both items before
 * signing either, then proves possession of the trade key over the digest it
 * computed itself. `perplSetupNeeds` turns `/trade/perpl/account` into what is
 * left to do, without re-opening an account that exists.
 *
 * Plain TS, no React Native: `flow.test.ts` runs under plain node.
 */
import { KURU_TESTNET_MARKETS, type KuruMarketConfig } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { perplProofOfPossession, type PerplTradeKey } from '../auth/perplKey.ts';
import { NoDeviceKeyError, type Approver } from '../auth/privyApproval.ts';
import { publicClient } from '../chain/client.ts';
import { confirmationDelay } from '../wallet/confirmation.ts';
import { TradeApiError, type TradeApi } from './api.ts';
import { KURU_BUILDER_PIN, type KuruBuilderPin } from './kuruBuilder.ts';
import {
  depositCapAtoms,
  KuruMarketError,
  readMarketFacts,
  worstPriceUnits,
  type MarketFacts,
} from './kuruMarket.ts';
import type {
  EnrollCommitRequest,
  EnrollCommitResult,
  KuruCancelIntent,
  KuruIntent,
  KuruPlaceIntent,
  KuruWithdrawIntent,
  PerplAccount,
  PerplOnboardIntent,
  PreparedTrade,
  TradeStatus,
  TradeView,
} from './types.ts';
import { verifyKuruTrade } from './verifyKuru.ts';
import {
  PERPL_MIN_ACCOUNT_OPEN_ATOMS,
  verifyEnrollmentPrepare,
  verifyPerplOnboard,
} from './verifyPerpl.ts';

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

/**
 * The cancel draft for one of the user's resting orders, as `/portfolio` lists
 * it (SEN-144). The market comes from the phone's own table by symbol, never
 * from the server, so the verifier checks the cancel against a market this
 * phone knows. `null` for anything this flow cannot cancel: a Perpl order
 * (U-14) or a Kuru symbol the app does not trade.
 */
export function kuruCancelDraft(order: {
  readonly venue: string;
  readonly symbol: string;
  readonly id: string;
}): Omit<KuruCancelIntent, 'clientTradeId'> | null {
  if (order.venue !== 'kuru') return null;
  const market = KURU_TESTNET_MARKETS.find((m) => m.symbol === order.symbol);
  if (market === undefined) return null;
  return { kind: 'kuru.cancel', market: market.address, orderId: order.id };
}

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
  | { readonly phase: 'preparing'; readonly intent: KuruIntent | PerplOnboardIntent }
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
  /** The Sente builder this build accepts; defaults to `KURU_BUILDER_PIN`. */
  builder?: KuruBuilderPin | null;
};

/** The server proposed something the verifier refused; nothing was signed. */
export class TradeApprovalRefusedError extends Error {
  readonly problem: string;
  readonly stepIndex: number | undefined;

  /** `subject` names what was refused in the copy: a trade unless said otherwise. */
  constructor(problem: string, stepIndex?: number, subject = 'This trade') {
    super(
      `${subject} doesn’t match what you confirmed, so it wasn’t signed: ${problem}. ` +
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

  const builder = opts.builder === undefined ? KURU_BUILDER_PIN : opts.builder;
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
    intent = placeIntent(draft, clientTradeId, market, facts, ctx.slippageBps, builder);
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
    builder,
    nowSeconds: Math.floor((opts.now ?? Date.now)() / 1000),
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
  builder: KuruBuilderPin | null,
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
    builder?.feePps ?? 0,
  );
  return { ...draft, clientTradeId, maxDepositAtoms: cap.toString() };
}

// ─── Perpl (SEN-104) ────────────────────────────────────────────────────────

/** The label the phone's trade key is enrolled under; Perpl shows it in the key list. */
export const PERPL_TRADE_KEY_ENROLL_LABEL = 'sente-app';

/**
 * What a wallet still needs before it can trade perps from this phone.
 *
 * - `open`: no Perpl account — approve, open it, allow forwarding.
 * - `forwarding`: the account is open, forwarding is not known on — that leg alone.
 * - `enroll`: no trade key enrolled — enroll it (and the server's read key).
 */
export type PerplSetupNeeds = {
  readonly open: boolean;
  readonly forwarding: boolean;
  readonly enroll: boolean;
};

/**
 * The trade key's api-key token: the server's (it persists it, SEN-174), else
 * the one this phone kept from its own enrollment. `null`: not enrolled.
 */
export function perplApiKeyOf(account: PerplAccount, stored: string | null): string | null {
  return account.apiKey ?? stored ?? null;
}

/**
 * Reads `/trade/perpl/account` into steps.
 *
 * `forwarding: false` is the server's "I did not see it", not "it is off": the
 * evidence is lost on an API restart (docs/user-trading.md, "Known gaps"). A
 * wallet whose trade key is enrolled went through an onboarding that ended
 * with forwarding on, so it is not asked again — that would be a sponsored
 * user operation for nothing. Without a key, re-allowing it is harmless and
 * the planner does it alone; never a second `createAccount`.
 */
export function perplSetupNeeds(account: PerplAccount, stored: string | null): PerplSetupNeeds {
  const open = account.accountId === null;
  const enroll = perplApiKeyOf(account, stored) === null;
  return { open, forwarding: !open && !account.forwarding && enroll, enroll };
}

export function perplReady(needs: PerplSetupNeeds): boolean {
  return !needs.open && !needs.forwarding && !needs.enroll;
}

export type PerplFlowContext = {
  /** Privy's id for the user's wallet; pins every step's envelope. */
  readonly walletId: string;
  /** The same wallet's address: the Perpl account's owner. */
  readonly wallet: Address;
};

/** `already_onboarded`: the server had nothing left to sign (account open, forwarding seen). */
export type PerplOnboardOutcome = TradeOutcome | { readonly status: 'already_onboarded' };

/**
 * Opens the wallet's Perpl account, or resumes one: prepare → `verifyPerplOnboard`
 * → sign every step → commit → follow, the same order as {@link runTrade}.
 *
 * `accountOpen` is what `/trade/perpl/account` said. With the account already
 * open the phone signs only `allowOrderForwarding`, whatever the planner
 * proposes: a second `approve` + `createAccount` would move another deposit
 * the user did not confirm here. The amount is then moot (the planner ignores
 * it), and the minimum is sent so the verifier's floor still holds.
 */
export async function runPerplOnboard(
  api: TradeFlowApi,
  draft: { readonly amountAtoms: string },
  ctx: PerplFlowContext & { readonly accountOpen: boolean },
  sign: Approver | null,
  onUpdate: (state: TradeFlowState) => void,
  opts: TradeFlowOptions = {},
): Promise<PerplOnboardOutcome> {
  if (!sign) throw new NoDeviceKeyError('setting up perps');
  const clientTradeId = (opts.newClientTradeId ?? (() => globalThis.crypto.randomUUID()))();
  const intent: PerplOnboardIntent = {
    kind: 'perpl.onboard',
    clientTradeId,
    amountAtoms: ctx.accountOpen ? PERPL_MIN_ACCOUNT_OPEN_ATOMS.toString() : draft.amountAtoms,
  };

  onUpdate({ phase: 'preparing', intent });
  let prepared: PreparedTrade;
  try {
    prepared = await api.prepare(intent);
  } catch (error) {
    if (error instanceof TradeApiError && error.reason === 'perpl_already_onboarded') {
      return { status: 'already_onboarded' };
    }
    throw error;
  }

  onUpdate({ phase: 'verifying', prepared });
  if (prepared.clientTradeId !== clientTradeId) {
    throw new TradeApprovalRefusedError('the prepared trade is for another trade id');
  }
  const verdict = verifyPerplOnboard(prepared.steps, {
    walletId: ctx.walletId,
    wallet: ctx.wallet,
    intent,
  });
  if (!verdict.ok) throw new TradeApprovalRefusedError(verdict.problem, verdict.stepIndex);
  if (
    ctx.accountOpen &&
    !(prepared.steps.length === 1 && prepared.steps[0]?.kind === 'perpl.allowForwarding')
  ) {
    throw new TradeApprovalRefusedError(
      'your Perpl account is already open, so only turning on order forwarding may be signed',
    );
  }

  onUpdate({ phase: 'signing', prepared });
  const signatures = prepared.steps.map((step) => sign(step.payload));

  onUpdate({ phase: 'committing', prepared });
  const outcome = await follow(api, prepared.tradeId, signatures, onUpdate, opts);
  onUpdate({ phase: 'settled', outcome });
  return outcome;
}

/** The two enrollment routes; a fake in tests, `TradeApi` in the app. */
export type PerplEnrollApi = Pick<TradeApi, 'enrollPrepare' | 'enrollCommit'>;

/** Where the phone keeps its api-key token per wallet (`platform/kv` in the app). */
export type PerplApiKeyStore = {
  save(wallet: Address, apiKey: string): Promise<void>;
};

export type PerplEnrollPhase = 'preparing' | 'verifying' | 'signing' | 'committing';

export type PerplEnrollOptions = {
  /** Shown in the user's Perpl key list. */
  label?: string;
  /** The phone's clock, Unix ms: the verifier refuses a stale or future `time`. */
  now?: () => number;
  onPhase?: (phase: PerplEnrollPhase) => void;
};

/**
 * Enrolls this phone's trade key with the wallet's Perpl account (and the
 * server's read key, in the same prepare): derive the key → prepare →
 * `verifyEnrollmentPrepare` → sign BOTH items with the device key → prove
 * possession of the trade key over the digest the phone computed → commit.
 * A refusal at any check signs nothing. The trade key's secret is zeroed
 * before this returns, on every path. The token is kept per wallet in
 * `store`; a failure to keep it is not a failed enrollment (the server holds
 * it too).
 */
export async function runPerplEnrollment(
  api: PerplEnrollApi,
  ctx: PerplFlowContext,
  keys: {
    readonly sign: Approver | null;
    readonly tradeKey: ((wallet: Address) => PerplTradeKey) | null;
  },
  store: PerplApiKeyStore,
  opts: PerplEnrollOptions = {},
): Promise<EnrollCommitResult> {
  const { sign, tradeKey } = keys;
  if (!sign || !tradeKey) throw new NoDeviceKeyError('setting up perps');
  const label = opts.label ?? PERPL_TRADE_KEY_ENROLL_LABEL;
  const phase = opts.onPhase ?? (() => undefined);
  const key = tradeKey(ctx.wallet);
  let commit: EnrollCommitRequest;
  try {
    phase('preparing');
    const prepared = await api.enrollPrepare({ publicKeyHex: key.publicKeyHex, label });

    phase('verifying');
    const verdict = verifyEnrollmentPrepare(prepared, {
      walletId: ctx.walletId,
      wallet: ctx.wallet,
      tradePublicKeyHex: key.publicKeyHex,
      tradeLabel: label,
      now: (opts.now ?? Date.now)(),
    });
    if (!verdict.ok) {
      throw new TradeApprovalRefusedError(verdict.problem, undefined, 'This Perpl key enrollment');
    }

    phase('signing');
    commit = {
      prepareId: prepared.prepareId,
      signatures: prepared.items.map((item) => sign(item.payload)),
      popSignature: perplProofOfPossession(key.secretKey, verdict.digest),
    };
  } finally {
    key.secretKey.fill(0);
  }

  phase('committing');
  const result = await api.enrollCommit(commit);
  await store.save(ctx.wallet, result.apiKey).catch(() => undefined);
  return result;
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
    case 'below_min_account_open':
      return {
        title: 'Perpl needs at least 100 AUSD',
        detail: 'A Perpl account opens with 100 AUSD or more. Raise the amount.',
      };
    case 'perpl_already_onboarded':
      return {
        title: 'Your Perpl account is already set up',
        detail: 'There was nothing left to sign.',
      };
    case 'perpl_not_onboarded':
      return {
        title: 'Open your Perpl account first',
        detail: 'A trading key can only be added to an account that exists.',
      };
    case 'perpl_enroll_refused':
      return {
        title: 'Perpl refused the key',
        detail: `Perpl didn’t accept this phone’s trading key. Try again in a minute. (${error.message})`,
      };
    case 'perpl_format_changed':
      return {
        title: 'Perpl changed its sign-up format',
        detail: 'This version of the app can’t check the new one, so nothing was signed.',
      };
    case 'enroll_prepare_not_found':
      return {
        title: 'The sign-up expired',
        detail: 'It lasts a few minutes. Start it again.',
      };
    default:
      return { title: 'The trade didn’t go through', detail: error.message };
  }
}
