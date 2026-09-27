/**
 * The user's own manual trades: prepare, commit, status (SEN-96, plan M-T14,
 * "Architecture §4").
 *
 * PREPARE composes and stores; it sends nothing. The planner (SEN-95) turns
 * the intent into steps, each step becomes a sponsored `eth_sendTransaction`
 * from the user's Privy wallet (SEN-87), and the phone receives exactly the
 * authorization payloads its device key would sign. The phone then decodes
 * and checks every one against the order the user confirmed (SEN-85…) — so
 * everything that crosses here must be byte-identical to what the phone's
 * strict checks expect:
 *
 * - `params.transaction` comes from `sponsoredCallTransaction`, the one
 *   builder of the canonical shape (checksummed `to`, `value` only when
 *   non-zero, `chain_id` 10143);
 * - each step's `privy-idempotency-key` is {@link tradeIdempotencyKey}, byte
 *   for byte the phone's `apps/mobile/src/trade/envelope.ts#tradeIdempotencyKey`.
 *
 * COMMIT claims the trade once (`TradeStore.claimForCommit`) and hands it to
 * the `StepExecutor` in the background; the phone polls `GET /trade/:id`.
 * A second commit resends nothing and answers with the current view.
 *
 * IDEMPOTENCY: the phone's `clientTradeId` names the trade. The same id with
 * the same intent returns the same prepared trade (the same payloads, which
 * may already be on the phone); a different intent under it is 409
 * `trade_id_conflict`. "Same intent" is a hash over the canonical intent
 * rebuilt from the kind's own fields ({@link toTradeIntent}), so field order,
 * address casing and stray fields cannot make a retry look like a new trade.
 *
 * RECONCILE ON READ: the executor calls a step `unknown` when no receipt came
 * within the confirmation timeout, and leaves the trade `executing` because
 * the operation may still land (plan §2). Nothing else would ever revisit it,
 * so every read asks the bundler again for such steps and settles them
 * ({@link TradeService.reconcile}). A place settled this way gets its fills
 * decoded exactly as an on-time one does (SEN-97, `outcome.ts`).
 *
 * A step `unknown` WITHOUT a user-operation hash (SEN-97) is settled from
 * what there is:
 *
 * - with a transaction hash, Privy broadcast a plain transaction rather than a
 *   user operation, so that transaction's own receipt IS the verdict — gotcha
 *   8 is about operations inside a bundle, and there is none here;
 * - with no hash at all (the send died without an answer), nothing this
 *   server can reach will ever say whether it went out. Privy has no lookup by
 *   idempotency key short of resending, which would send it if it had not
 *   gone. So it is never called `not_sent`. After {@link UNVERIFIABLE_AFTER_MS}
 *   the step stays `unknown` with error {@link SEND_UNVERIFIABLE}, and the
 *   trade is `failed` rather than `executing` forever: the phone stops
 *   polling, shows that error (check your balances before trying again), and
 *   retention can finally forget the trade.
 */

import { Inject, Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { KuruLog } from '@sente/venues/kuru';
import { getAddress, type PublicClient } from 'viem';

import { PREPARED_APPROVAL_TTL_MS } from '../agents/prepared-approval';
import type { Principal } from '../auth/principal';
import { BUNDLER, type Bundler } from '../wallet/bundler/bundler';
import { sponsoredCallTransaction } from '../wallet/send/sponsored-send';
import {
  USER_WALLET_REGISTRY,
  type UserWalletBinding,
  type UserWalletRegistry,
} from '../wallet/store/user-wallet-registry';
import { USER_WALLETS, type UserWalletProvider } from '../wallet/user-wallet.provider';
import { MONAD_PUBLIC_CLIENT } from '../wallet/wallet.module';
import { WalletRefusedError, walletRefusalToHttpException } from '../wallet/wallet.errors';
import type {
  PreparedTradeDto,
  TradeCapabilitiesDto,
  TradeIntentDto,
  TradeViewDto,
} from './dto/trade.dto';
import {
  KuruPlanRefusedError,
  planKuru,
  type KuruIntent,
  type KuruPlanRefusalReason,
} from './kuru-planner';
import { fundsAfter, TradeOutcomes } from './outcome';
import { StepExecutor } from './step-executor';
import { TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeStore, type StepStatus, type Trade, type TradeStep } from './trade-store';

/** Plan "Shared wire types". Planned in M-T17; accepted and refused until then. */
export type PerplOnboardIntent = {
  kind: 'perpl.onboard';
  clientTradeId: string;
  amountAtoms: string;
};
export type TradeIntent = KuruIntent | PerplOnboardIntent;

/**
 * The `privy-idempotency-key` of step `stepIndex`. MUST equal the phone's
 * `tradeIdempotencyKey` (`apps/mobile/src/trade/envelope.ts`) byte for byte:
 * the phone refuses to sign a payload whose key differs, and Privy drops a
 * repeat of the same key for 24h, which is what makes a replayed signature
 * harmless.
 */
export function tradeIdempotencyKey(clientTradeId: string, stepIndex: number): string {
  return `sente-trade:${clientTradeId}:${stepIndex}`;
}

/**
 * Every way a trade request is refused. Part of the API contract — the app
 * branches on these strings (M-T20) — so a rename is a breaking change. The
 * wallet's own reasons (`account_not_registered`, `user_wallets_unconfigured`)
 * still come through as `WalletRefusedError`.
 */
export type TradeRefusalReason =
  | 'trading_disabled'
  | 'not_supported_yet'
  | 'trade_id_conflict'
  | 'trade_not_found'
  | 'trade_expired'
  | 'signature_count_mismatch'
  | KuruPlanRefusalReason;

const REFUSAL_STATUS: Record<TradeRefusalReason, HttpStatus> = {
  // 404, not 403: with the flag off the routes should look absent (plan §5).
  trading_disabled: HttpStatus.NOT_FOUND,
  not_supported_yet: HttpStatus.BAD_REQUEST,
  trade_id_conflict: HttpStatus.CONFLICT,
  trade_not_found: HttpStatus.NOT_FOUND,
  // 410 like the wallet's `prepare_expired`: it existed and cannot be committed now.
  trade_expired: HttpStatus.GONE,
  signature_count_mismatch: HttpStatus.BAD_REQUEST,
  // The intent itself is malformed or names something this app does not trade.
  invalid_intent: HttpStatus.BAD_REQUEST,
  market_not_allowed: HttpStatus.BAD_REQUEST,
  // Well-formed, but the chain says no right now: 422, so the app can tell
  // "fix your input" from "your order cannot go through as it stands".
  below_min_notional: HttpStatus.UNPROCESSABLE_ENTITY,
  reserve_balance: HttpStatus.UNPROCESSABLE_ENTITY,
  deposit_cap_exceeded: HttpStatus.UNPROCESSABLE_ENTITY,
  insufficient_balance: HttpStatus.UNPROCESSABLE_ENTITY,
  // The order is already filled or cancelled — a conflict with the book's state.
  already_terminal: HttpStatus.CONFLICT,
};

export class TradeRefusedError extends Error {
  readonly reason: TradeRefusalReason;

  constructor(reason: TradeRefusalReason, message: string) {
    super(message);
    this.name = 'TradeRefusedError';
    this.reason = reason;
  }
}

/** Maps trade and wallet refusals to a clean 4xx/5xx with a stable `reason`; rethrows the rest. */
export function tradeRefusalToHttpException(error: unknown): unknown {
  if (error instanceof WalletRefusedError) return walletRefusalToHttpException(error);
  if (!(error instanceof TradeRefusedError)) return error;
  const statusCode = REFUSAL_STATUS[error.reason];
  return new HttpException(
    { statusCode, reason: error.reason, message: error.message },
    statusCode,
  );
}

/**
 * The trade as stored, plus the plan's render-only summary. The store has no
 * summary field, and its updates spread the whole object (`{...trade,
 * ...patch}`), so an extra property survives every executor write; the spec
 * pins that. A retried prepare needs it to answer with the same summary.
 */
type TradeWithSummary = Trade & { readonly summary?: Record<string, string> };

/**
 * The error of a hashless `unknown` step once nobody will ever settle it. Part
 * of the API contract, like the refusal reasons: the phone branches on it.
 */
export const SEND_UNVERIFIABLE = 'send_unverifiable';

/**
 * How long past the later of the commit deadline and the trade's last change
 * a hashless `unknown` step keeps the trade `executing`. The send was one
 * synchronous Privy call, so anything that did go out went out then; half an
 * hour is far past any bundler inclusion, and short enough that the phone is
 * not left spinning.
 */
export const UNVERIFIABLE_AFTER_MS = 30 * 60 * 1000;

const STEP_IN_FLIGHT: ReadonlySet<StepStatus> = new Set([
  'awaiting_signature',
  'queued',
  'submitted',
  'unknown',
]);

@Injectable()
export class TradeService {
  private readonly logger = new Logger(TradeService.name);

  constructor(
    @Inject(TRADE_CONFIG) private readonly config: TradeConfig,
    private readonly store: TradeStore,
    private readonly executor: StepExecutor,
    @Inject(USER_WALLETS) private readonly wallets: Pick<UserWalletProvider, 'prepareSend'>,
    @Inject(USER_WALLET_REGISTRY) private readonly registry: Pick<UserWalletRegistry, 'find'>,
    @Inject(BUNDLER) private readonly bundler: Pick<Bundler, 'receipt'>,
    @Inject(MONAD_PUBLIC_CLIENT) private readonly client: PublicClient,
    private readonly outcomes: TradeOutcomes,
  ) {}

  capabilities(): TradeCapabilitiesDto {
    const { enabled, atomicBatch, chainId } = this.config;
    // Perpl onboarding and orders arrive with M-T17/M-T23; until then the app
    // must not offer them.
    return { enabled, atomicBatch, chainId, venues: { kuru: enabled, perpl: false } };
  }

  async prepare(principal: Principal, dto: TradeIntentDto): Promise<PreparedTradeDto> {
    this.assertEnabled();
    const intent = toTradeIntent(dto);
    if (intent.kind === 'perpl.onboard') {
      throw new TradeRefusedError(
        'not_supported_yet',
        'Perpl onboarding is not available yet; only Kuru trades can be prepared',
      );
    }
    const binding = await this.bound(principal);
    const intentHash = hashIntent(intent);
    const now = this.now();

    // A retry is answered from the store, before planning: its payloads may
    // already be on the phone, and a re-plan against a moved book could differ.
    const existing = this.store.byClientId(principal.userId, intent.clientTradeId, now);
    if (existing && existing.status !== 'expired') {
      return toPrepared(this.sameIntentOrRefuse(existing, intentHash));
    }

    const plan = await this.planOrRefuse(intent, binding);
    const steps: TradeStep[] = [];
    for (const [index, planned] of plan.steps.entries()) {
      const { to, data, value } = planned.transaction;
      const prepared = await this.wallets.prepareSend({
        walletId: binding.walletId,
        transaction: sponsoredCallTransaction(to, data, value),
        idempotencyKey: tradeIdempotencyKey(intent.clientTradeId, index),
      });
      steps.push({
        index,
        kind: planned.kind,
        title: planned.title,
        request: prepared.request,
        payload: prepared.payload,
        status: 'awaiting_signature',
      });
    }

    const trade: TradeWithSummary = {
      id: randomUUID(),
      userId: principal.userId,
      clientTradeId: intent.clientTradeId,
      intentHash,
      kind: intent.kind,
      walletId: binding.walletId,
      address: binding.address,
      steps,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PREPARED_APPROVAL_TTL_MS),
      summary: plan.summary,
      ...(plan.place ? { place: plan.place } : {}),
    };
    // `put` re-checks the client id: two prepares racing past `byClientId`
    // above both get here, and exactly one trade may win.
    const stored = this.store.put(trade, now);
    if (stored === 'conflict') throw conflict(intent.clientTradeId);
    return toPrepared(stored);
  }

  async commit(principal: Principal, tradeId: string, signatures: string[]): Promise<TradeViewDto> {
    this.assertEnabled();
    const now = this.now();
    const found = this.store.get(principal.userId, tradeId, now);
    if (!found) throw notFound(tradeId);
    if (found.status === 'expired') throw expired(tradeId);
    // Checked BEFORE the claim: a claimed trade is `executing` for good, and a
    // miscounted commit must leave it committable.
    if (found.status === 'prepared' && signatures.length !== found.steps.length) {
      throw new TradeRefusedError(
        'signature_count_mismatch',
        `trade ${tradeId} has ${found.steps.length} steps and ${signatures.length} signatures`,
      );
    }

    const claimed = this.store.claimForCommit(principal.userId, tradeId, now);
    if (claimed === undefined) throw notFound(tradeId);
    if (claimed === 'expired') throw expired(tradeId);
    if (claimed === 'committed') return this.status(principal, tradeId);

    // In the background: the steps take a receipt each, and the phone polls.
    // The executor records every outcome itself and rejects only on the count
    // checked above, so this catch is for the unforeseen.
    this.executor.execute(claimed, signatures).catch((error: unknown) => {
      this.logger.error(`trade ${tradeId}: the executor failed: ${describe(error)}`);
    });
    return toView(this.store.get(principal.userId, tradeId) ?? claimed);
  }

  async status(principal: Principal, tradeId: string): Promise<TradeViewDto> {
    this.assertEnabled();
    const found = this.store.get(principal.userId, tradeId, this.now());
    if (!found) throw notFound(tradeId);
    return toView(await this.reconcile(found));
  }

  async list(principal: Principal, limit = 20): Promise<TradeViewDto[]> {
    this.assertEnabled();
    const trades = this.store.listRecent(principal.userId, limit, this.now());
    return (await Promise.all(trades.map((trade) => this.reconcile(trade)))).map(toView);
  }

  /** Overridable clock for the spec. */
  protected now(): Date {
    return new Date();
  }

  /**
   * Settles steps the executor gave up on (`unknown`) and recomputes the
   * trade: from the user operation's own receipt — its `success`, never the
   * carrying transaction's status (CLAUDE.md gotcha 8) — or, for a step with
   * no operation hash, as the file header describes.
   *
   * Only `unknown` steps are touched: those are the ones the executor has
   * finished with (it stops at the first one), so this never races its writes.
   * A lookup error or a still-missing receipt leaves the step as it was; the
   * next read asks again. A place that turns out to have landed gets its
   * `result` from the same decoder the executor's hook uses (SEN-97).
   */
  private async reconcile(trade: Trade): Promise<Trade> {
    if (trade.status !== 'executing') return trade;
    if (!trade.steps.some((s) => s.status === 'unknown')) return trade;

    const now = this.now();
    const landed: { step: TradeStep; logs: readonly KuruLog[] }[] = [];
    let unverifiable = false;
    const steps = await Promise.all(
      trade.steps.map(async (step): Promise<TradeStep> => {
        if (step.status !== 'unknown') return step;
        const settled = await this.settle(trade, step, now);
        if (!settled) return step;
        if (settled.step.status === 'unknown') unverifiable = true;
        else landed.push({ step: settled.step, logs: settled.logs });
        return settled.step;
      }),
    );
    if (!unverifiable && landed.length === 0) return trade;

    let result = trade.result;
    for (const { step, logs } of landed) {
      try {
        result = (await this.outcomes.placeResult(trade, step, logs)) ?? result;
      } catch (error) {
        // As in the executor's hook: the step landed either way.
        this.logger.error(
          `trade ${trade.id} step ${step.index} settled ${step.status}, but reading its ` +
            `outcome failed: ${describe(error)}`,
        );
      }
    }

    const status = steps.every((s) => s.status === 'included')
      ? 'completed'
      : !unverifiable && steps.some((s) => STEP_IN_FLIGHT.has(s.status))
        ? 'executing'
        : 'failed';
    this.logger.log(`trade ${trade.id} reconciled: ${status}`);
    const withResult = { steps, status, ...(result ? { result } : {}) } as const;
    const funds = fundsAfter({ ...trade, ...withResult });
    const patch = { ...withResult, ...(funds ? { funds } : {}) };
    return this.store.update(trade.id, patch) ?? { ...trade, ...patch };
  }

  /**
   * One `unknown` step's settlement, or undefined to leave it for the next
   * read. `logs` are the landed execution's own logs, for the fill decoder.
   */
  private async settle(
    trade: Trade,
    step: TradeStep,
    now: Date,
  ): Promise<{ step: TradeStep; logs: readonly KuruLog[] } | undefined> {
    const { error: _stale, ...rest } = step;
    if (step.userOpHash) {
      const receipt = await this.bundler.receipt(step.userOpHash).catch((error: unknown) => {
        this.logger.debug(`reconcile ${step.userOpHash}: ${describe(error)}`);
        return null;
      });
      if (!receipt) return undefined;
      return {
        logs: receipt.logs,
        step: {
          ...rest,
          status: receipt.success ? 'included' : 'reverted',
          transactionHash: receipt.receipt.transactionHash,
          blockNumber: receipt.receipt.blockNumber.toString(),
          ...(receipt.success ? {} : { error: receipt.reason ?? 'the user operation reverted' }),
        },
      };
    }

    if (step.transactionHash) {
      // A plain broadcast, not a user operation: its own receipt decides.
      const hash = step.transactionHash;
      const receipt = await this.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        this.logger.debug(`reconcile tx ${hash}: ${describe(error)}`);
        return null;
      });
      if (!receipt) return undefined;
      const included = receipt.status === 'success';
      return {
        logs: receipt.logs,
        step: {
          ...rest,
          status: included ? 'included' : 'reverted',
          blockNumber: receipt.blockNumber.toString(),
          ...(included ? {} : { error: 'the transaction reverted' }),
        },
      };
    }

    const since = Math.max(trade.expiresAt.getTime(), trade.updatedAt.getTime());
    if (now.getTime() < since + UNVERIFIABLE_AFTER_MS) return undefined;
    this.logger.warn(
      `trade ${trade.id} step ${step.index}: no hash to follow and nothing to ask; ` +
        `it may or may not have been sent (was: ${step.error ?? 'no error'})`,
    );
    return { logs: [], step: { ...rest, status: 'unknown', error: SEND_UNVERIFIABLE } };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new TradeRefusedError('trading_disabled', 'Manual trading is not enabled here');
    }
  }

  private async bound(principal: Principal): Promise<UserWalletBinding> {
    const binding = await this.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No wallet for this user; POST /wallet/register with the device public key first',
      );
    }
    return binding;
  }

  private sameIntentOrRefuse(existing: Trade, intentHash: string): Trade {
    if (existing.intentHash !== intentHash) throw conflict(existing.clientTradeId);
    return existing;
  }

  private async planOrRefuse(intent: KuruIntent, binding: UserWalletBinding) {
    try {
      return await planKuru(intent, {
        client: this.client,
        wallet: binding.address,
        atomicBatch: this.config.atomicBatch,
      });
    } catch (error) {
      if (error instanceof KuruPlanRefusedError) {
        throw new TradeRefusedError(error.reason, error.message);
      }
      throw error;
    }
  }
}

/**
 * The intent the DTO names, built from its kind's fields only — so a field of
 * another kind can reach neither the planner nor the hash. Addresses are
 * checksummed, `postOnly` is a definite boolean: one intent, one spelling.
 * The DTO has already validated every field used here.
 */
export function toTradeIntent(dto: TradeIntentDto): TradeIntent {
  const clientTradeId = dto.clientTradeId;
  switch (dto.kind) {
    case 'kuru.place':
      return {
        kind: dto.kind,
        clientTradeId,
        market: getAddress(dto.market!),
        side: dto.side!,
        orderType: dto.orderType!,
        sizeAtoms: dto.sizeAtoms!,
        priceUnits: dto.priceUnits!,
        postOnly: dto.postOnly === true,
        maxDepositAtoms: dto.maxDepositAtoms!,
      };
    case 'kuru.cancel':
      return {
        kind: dto.kind,
        clientTradeId,
        market: getAddress(dto.market!),
        orderId: dto.orderId!,
      };
    case 'kuru.withdraw':
      return {
        kind: dto.kind,
        clientTradeId,
        token: getAddress(dto.token!),
        amountAtoms: dto.amountAtoms!,
      };
    case 'perpl.onboard':
      return { kind: dto.kind, clientTradeId, amountAtoms: dto.amountAtoms! };
  }
}

/** sha256 of the intent as JSON with sorted keys. Every value is a string or boolean. */
export function hashIntent(intent: TradeIntent): string {
  const sorted = Object.fromEntries(
    Object.entries(intent).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function toPrepared(trade: TradeWithSummary): PreparedTradeDto {
  return {
    tradeId: trade.id,
    clientTradeId: trade.clientTradeId,
    expiresAt: trade.expiresAt.toISOString(),
    wallet: { walletId: trade.walletId, address: trade.address },
    // The payload crosses untouched: it is the signed object.
    steps: trade.steps.map((step) => ({
      index: step.index,
      kind: step.kind,
      title: step.title,
      payload: step.payload,
    })),
    summary: trade.summary ?? {},
  };
}

/** Never the stored request or payload: a view is for polling, not for signing. */
export function toView(trade: Trade): TradeViewDto {
  return {
    tradeId: trade.id,
    clientTradeId: trade.clientTradeId,
    kind: trade.kind,
    status: trade.status,
    steps: trade.steps.map((step) => ({
      index: step.index,
      kind: step.kind,
      title: step.title,
      status: step.status,
      ...(step.userOpHash ? { userOpHash: step.userOpHash } : {}),
      ...(step.transactionHash ? { transactionHash: step.transactionHash } : {}),
      ...(step.blockNumber ? { blockNumber: step.blockNumber } : {}),
      ...(step.error ? { error: step.error } : {}),
    })),
    ...(trade.result ? { result: trade.result } : {}),
    ...(trade.funds ? { funds: trade.funds } : {}),
    updatedAt: trade.updatedAt.toISOString(),
  };
}

function conflict(clientTradeId: string): TradeRefusedError {
  return new TradeRefusedError(
    'trade_id_conflict',
    `clientTradeId ${clientTradeId} already names a different trade`,
  );
}

function notFound(tradeId: string): TradeRefusedError {
  return new TradeRefusedError('trade_not_found', `No trade ${tradeId}`);
}

function expired(tradeId: string): TradeRefusedError {
  return new TradeRefusedError('trade_expired', `Trade ${tradeId} expired; prepare it again`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
