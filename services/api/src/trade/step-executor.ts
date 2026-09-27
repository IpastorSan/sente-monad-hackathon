/**
 * Runs a committed trade's steps, one user operation at a time (SEN-94, plan
 * M-T11).
 *
 * A trade is `[approve?, deposit?, place]` (or one packed `batch`), each step a
 * device-signed sponsored send. They are NOT atomic by default (plan §2,
 * "Batching"): the phone signs every payload at once, and this class sends
 * them in order, each only after the previous user operation reported
 * `success`. A deposit that lands before a place that reverts leaves the USDC
 * in the user's Kuru account, which M-T15 turns into "where your funds are":
 * {@link StepExecutor.onStepLanded} decodes a landed place's fills into the
 * trade's `result`, and a finished trade gets its `funds` (SEN-97,
 * `outcome.ts`).
 *
 * Three rules shape everything below:
 *
 * - **Only the user operation's own `success` decides** (CLAUDE.md gotcha 8).
 *   The bundle transaction carrying it can succeed while the operation
 *   reverted, so `included`/`reverted` come from `bundler.receipt(hash)
 *   .success` and never from a transaction receipt. A send that comes back
 *   without a user-operation hash has nothing we can follow, so it is
 *   `unknown`, not `included`.
 * - **A timeout is `unknown`, never a failure** (plan §2). An operation that
 *   has not surfaced may land minutes later; calling it failed invites the user
 *   to place the order again. The trade then stays `executing` rather than
 *   `failed`, for the same reason.
 * - **Nothing after a step that did not land is sent.** Remaining steps become
 *   `not_sent`. Sending the place after a deposit we cannot account for would
 *   stack a second unknown on the first.
 *
 * Sends go through the wallet's `SEND_SPACER`, shared with the wallet's own
 * transfers: a send composed before the previous one from the same wallet
 * landed is refused with an EIP-7702 nonce mismatch (SEN-42), and Monad's
 * reserve rule punishes back-to-back sends (gotcha 12). On top of that a
 * per-wallet `KeyedMutex` keeps two trades for one wallet from interleaving
 * their steps — the spacer orders single sends, not whole sequences.
 *
 * No Nest decorator: the trade module (M-T1) builds it with a factory from the
 * wallet module's providers, and tests build it with fakes.
 */

import { Logger } from '@nestjs/common';
import type { Hash } from 'viem';
import type { UserOperationReceipt } from 'viem/account-abstraction';

import { PrivyError } from '../agents/privy/privy.client';
import { KeyedMutex } from '../agents/tools/keyed-mutex';
import type { WriteSpacer } from '../spacing/write-spacer';
import type { Bundler } from '../wallet/bundler/bundler';
import type { SponsoredSendOutcome } from '../wallet/send/sponsored-send';
import type { UserWalletProvider } from '../wallet/user-wallet.provider';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { fundsAfter, type TradeOutcomes } from './outcome';
import type { StepStatus, Trade, TradeStep, TradeStore } from './trade-store';

export interface StepExecutorOptions {
  /** Receipt poll interval — `WALLET_CONFIRMATION_POLL_MS`. */
  readonly pollMs: number;
  /** Stop waiting for one step after this — `WALLET_CONFIRMATION_TIMEOUT_MS`. */
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface StepExecutorDeps {
  readonly store: Pick<TradeStore, 'update'>;
  readonly wallets: Pick<UserWalletProvider, 'commitSend'>;
  readonly bundler: Pick<Bundler, 'receipt'>;
  /** The wallet module's `SEND_SPACER` — the same instance its transfers use. */
  readonly spacer: Pick<WriteSpacer, 'run'>;
  /** Decodes a landed place (SEN-97). Absent in specs about sending alone. */
  readonly outcomes?: Pick<TradeOutcomes, 'placeResult'>;
  readonly options: StepExecutorOptions;
}

/** How one step ended, as far as this server can tell. */
type Unlanded = { status: 'unknown' | 'not_sent'; error: string };
type StepOutcome = { status: 'included' | 'reverted' } | Unlanded;

export class StepExecutor {
  protected readonly logger = new Logger(StepExecutor.name);
  readonly #deps: StepExecutorDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #wallets = new KeyedMutex();

  constructor(deps: StepExecutorDeps) {
    this.#deps = deps;
    this.#now = deps.options.now ?? Date.now;
    this.#sleep = deps.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Sends a claimed trade's steps in order and records every transition in the
   * store. `signatures[i]` is the phone's signature over step `i`'s payload.
   *
   * Never rejects for a step's outcome — a refusal, a revert and a timeout are
   * all written to the trade, because the caller runs this in the background
   * and the phone learns the result by polling. It rejects only when the
   * signature count does not match, before anything is sent.
   */
  async execute(trade: Trade, signatures: readonly string[]): Promise<void> {
    if (signatures.length !== trade.steps.length) {
      throw new RangeError(
        `trade ${trade.id} has ${trade.steps.length} steps and ${signatures.length} signatures`,
      );
    }
    await this.#wallets.run(trade.walletId, () => this.#run(trade, signatures));
  }

  /**
   * Called once per step whose user operation landed, included or reverted,
   * with its receipt. A landed place becomes the trade's `result`, decoded
   * from the OPERATION's own `logs` (SEN-97) — the same `TradeOutcomes` call
   * `TradeService.reconcile` makes for a place it settles late. A throw is
   * logged and does not stop the trade: the step has already landed, and its
   * status must not depend on decoding it.
   */
  protected onStepLanded(
    step: TradeStep,
    receipt: UserOperationReceipt,
    trade: Trade,
  ): void | Promise<void> {
    const outcomes = this.#deps.outcomes;
    if (!outcomes) return;
    return outcomes.placeResult(trade, step, receipt.logs).then((result) => {
      if (result) this.#save(trade, { result });
    });
  }

  async #run(trade: Trade, signatures: readonly string[]): Promise<void> {
    let steps: TradeStep[] = trade.steps.map((step) => ({ ...step, status: 'queued' }));
    let current = this.#save(trade, { steps });

    const set = (index: number, patch: Partial<TradeStep>): void => {
      steps = steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
      current = this.#save(current, { steps });
    };

    for (const [index, step] of trade.steps.entries()) {
      const outcome = await this.#runStep(current, step, signatures[index], (patch) =>
        set(index, patch),
      );
      if (outcome.status === 'included') continue;

      for (let rest = index + 1; rest < steps.length; rest++) set(rest, { status: 'not_sent' });
      // An `unknown` step may still land, so the trade is not called failed.
      if (outcome.status !== 'unknown') current = this.#save(current, { status: 'failed' });
      this.#settleFunds(current);
      return;
    }
    this.#settleFunds(this.#save(current, { status: 'completed' }));
  }

  /**
   * Says where the deposit is once nothing is in flight. `trade` is the
   * store's copy, so it carries the `result` the hook wrote beside the
   * executor's own patches.
   */
  #settleFunds(trade: Trade): void {
    const funds = fundsAfter(trade);
    if (funds) this.#save(trade, { funds });
  }

  async #runStep(
    trade: Trade,
    step: TradeStep,
    signature: string,
    set: (patch: Partial<TradeStep>) => void,
  ): Promise<StepOutcome> {
    let sent: SponsoredSendOutcome;
    try {
      // `step.request` is the prepared `SendRequest`: its idempotency key is
      // signed bytes and must ride along unchanged (SEN-87).
      sent = await this.#deps.spacer.run(trade.walletId, () =>
        this.#deps.wallets.commitSend(step.request, { signature }),
      );
    } catch (error) {
      const outcome = this.#refusal(error, trade, step);
      set({ status: outcome.status, error: outcome.error });
      return outcome;
    }

    const hashes = sent.transactionHash ? { transactionHash: sent.transactionHash } : {};
    if (!sent.userOpHash) {
      // Privy broadcast something other than a sponsored user operation, or
      // answered with nothing to follow. It may well have moved funds, so the
      // honest status is `unknown`, and nothing further is sent.
      const error = 'the wallet provider returned no user-operation hash to follow';
      this.logger.warn(`trade ${trade.id} step ${step.index}: ${error}`);
      set({ status: 'unknown', error, ...hashes });
      return { status: 'unknown', error };
    }
    set({ status: 'submitted', userOpHash: sent.userOpHash, ...hashes });

    const receipt = await this.#awaitReceipt(sent.userOpHash);
    if (!receipt) {
      const error = `no receipt within ${this.#deps.options.timeoutMs}ms; it may still land`;
      this.logger.warn(`trade ${trade.id} step ${step.index} userOp ${sent.userOpHash}: ${error}`);
      set({ status: 'unknown', error });
      return { status: 'unknown', error };
    }

    // The OPERATION's flag, not the bundle transaction's status (gotcha 8).
    const status: StepStatus = receipt.success ? 'included' : 'reverted';
    set({
      status,
      transactionHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber.toString(),
      ...(receipt.success ? {} : { error: receipt.reason ?? 'the user operation reverted' }),
    });
    try {
      await this.onStepLanded({ ...step, status }, receipt, trade);
    } catch (error) {
      this.logger.error(
        `trade ${trade.id} step ${step.index} landed ${status}, but reading its outcome failed: ` +
          describe(error),
      );
    }
    return { status: receipt.success ? 'included' : 'reverted' };
  }

  /** Polls until a receipt appears or the timeout passes; `null` means `unknown`. */
  async #awaitReceipt(userOpHash: Hash): Promise<UserOperationReceipt | null> {
    const { pollMs, timeoutMs } = this.#deps.options;
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      try {
        const receipt = await this.#deps.bundler.receipt(userOpHash);
        if (receipt) return receipt;
      } catch (error) {
        // A transient bundler error is not a verdict; keep asking.
        this.logger.debug(`receipt poll failed for ${userOpHash}: ${describe(error)}`);
      }
      if (this.#now() >= deadline) return null;
      await this.#sleep(pollMs);
    }
  }

  /**
   * What a failed `commitSend` means for the step. The reasons are copied from
   * `UserWalletService.commitOrRefuse`, so the phone branches on the same
   * strings for a trade as for a transfer.
   *
   * An answer from Privy (or our own refusal) means the send did not go out:
   * `not_sent`. Anything else — a dropped connection, a timeout — may have
   * reached Privy after all, so it is `unknown`; the idempotency key is what
   * keeps a later retry from sending it twice.
   */
  #refusal(error: unknown, trade: Trade, step: TradeStep): Unlanded {
    const where = `trade ${trade.id} step ${step.index}`;
    if (error instanceof WalletRefusedError) {
      return { status: 'not_sent', error: error.reason };
    }
    if (error instanceof PrivyError) {
      this.logger.error(`Privy refused ${where}: ${error.message}`);
      if (error.isMissingApproval) return { status: 'not_sent', error: 'invalid_authorization' };
      if (error.code === 'transaction_broadcast_failure') {
        return { status: 'not_sent', error: 'send_broadcast_failed' };
      }
      return { status: 'not_sent', error: 'user_wallet_provider_failed' };
    }
    this.logger.error(`${where}: the send may or may not have reached Privy: ${describe(error)}`);
    return { status: 'unknown', error: 'user_wallet_provider_failed' };
  }

  #save(trade: Trade, patch: Parameters<TradeStore['update']>[1]): Trade {
    // `update` answers undefined only for a trade the store no longer holds,
    // which the sweep never does to an executing one; keep the local copy.
    return this.#deps.store.update(trade.id, patch) ?? { ...trade, ...patch };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
