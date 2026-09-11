import type { Address, Hash } from 'viem';

import { GasDripRefusedError } from '../gas.errors';
import type { DripSendResult, DripSender } from './drip-sender';
import type { SenderPool } from './sender-pool';

/**
 * ---------------------------------------------------------------------------
 * MONAD'S RESERVE BALANCE (CLAUDE.md gotcha 12)
 *
 * Monad keeps a 10 MON reserve per account. An EOA holding less may still send
 * MON, but only as its first transaction in the last few blocks; a second MON
 * transfer in quick succession is included, reverts with `reserve balance
 * violation`, and is charged its full gas limit. Faucet keys are small hot
 * wallets, so they live under 10 MON, and a drip is exactly a MON transfer.
 *
 * What this class does, and why each layer is there:
 *
 *   1. SPACING, the primary defence. A key is handed at most one send at a
 *      time, and the next send waits until `spacingMs` after the previous one's
 *      receipt, so every drip is its key's first transaction in the window.
 *      Other keys are tried before waiting. The pool records sends from the
 *      user drip too, so an agent drip also stays clear of those. Spacing is
 *      chosen over "keep every key above 10 MON" because that parks 10 MON per
 *      key for nothing, and over "retry the revert on another key" alone
 *      because every revert costs the gas limit.
 *
 *   2. SIMULATION, advisory. Before broadcasting, an `eth_call` of the exact
 *      transfer from the chosen key. If the node answers with a reserve-balance
 *      error, nothing is broadcast and the next attempt moves to another key.
 *      Any other simulation failure is logged and ignored. Measured 2026-09-11,
 *      read-only: Monad's `eth_call` and `eth_estimateGas` ACCEPT a lone MON
 *      transfer from an EOA holding 0.06 MON, so the simulation does not refuse
 *      every under-reserve key. Whether it catches the SECOND-in-window case is
 *      unmeasured, because testing that needs two real sends. So it can only
 *      save gas, never block a drip on its own.
 *
 *   3. RECEIPT, authoritative. The send waits for its receipt. A plain MON
 *      transfer with a gas limit sized from `eth_getCode` has no other known
 *      way to revert, so a reverted receipt is treated as a reserve-balance
 *      violation: the key cools down and the next attempt uses another key.
 *      No MON moved, so the caller may release its budget. At most
 *      `maxAttempts` sends, so a revert with some other cause costs at most
 *      that many gas limits (3 x 21k at ~100 gwei ≈ 0.006 MON).
 *
 * A receipt that does not arrive in time is NOT retried: the transaction may
 * still land, and a second send would fund the agent twice.
 *
 * The user drip (`GasDripService.drip`) still goes through `SenderPool.send`
 * directly, unchanged, so it is not spaced. Moving it here is a one-line change
 * left out of SEN-14 on purpose.
 * ---------------------------------------------------------------------------
 */

/** DI token for the agent drip's dispatcher. */
export const AGENT_DRIP_DISPATCHER = Symbol('AGENT_DRIP_DISPATCHER');

/** Narrow slice of a viem public client (`eth_call`). Rejects with the node's error. */
export interface TransferSimulator {
  simulateTransfer(args: { from: Address; to: Address; value: bigint; gas: bigint }): Promise<void>;
}

/** Narrow slice of a viem public client. Rejects on timeout or RPC failure. */
export interface ReceiptWaiter {
  waitForReceipt(args: { hash: Hash; timeoutMs: number }): Promise<'success' | 'reverted'>;
}

export interface ConfirmedSend extends DripSendResult {
  /** Earlier attempts that were included but reverted: gas charged, no MON moved. */
  reverted: Hash[];
}

/** What `GasDripService` depends on. `ReserveAwareDispatcher` is the implementation. */
export interface AgentDripDispatcher {
  send(to: Address, valueWei: bigint, gasLimit: bigint): Promise<ConfirmedSend>;
}

/** Every attempt reverted, or would have. No MON moved. */
export class ReserveBalanceBusyError extends Error {
  constructor(readonly reverted: Hash[]) {
    super(
      `no faucet key could send without a reserve-balance violation ` +
        `(${reverted.length} reverted attempt(s))`,
    );
    this.name = 'ReserveBalanceBusyError';
  }
}

/** Broadcast, but no receipt in time. It may still land: do not re-send, do not release. */
export class DripUnconfirmedError extends Error {
  constructor(
    readonly sent: DripSendResult,
    cause: unknown,
  ) {
    super(`drip ${sent.hash} was not confirmed: ${describeError(cause)}`);
    this.name = 'DripUnconfirmedError';
  }
}

export interface ReserveAwareDispatcherOptions {
  spacingMs: number;
  receiptTimeoutMs: number;
  /** Sends (including ones the simulation stops) before giving up. Default 3. */
  maxAttempts?: number;
  /** Longest wait for a free key per attempt. Default: one receipt timeout plus one spacing. */
  maxWaitMs?: number;
  /** Must be the pool's clock, so both measure the same time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn(message: string): void };
}

const RESERVE_VIOLATION = /reserve balance/i;
/** Upper bound on one wait, so a key freed early (a receipt) is noticed. */
const POLL_MS = 250;

export class ReserveAwareDispatcher implements AgentDripDispatcher {
  private readonly inFlight = new Set<Address>();
  private cursor = 0;
  private readonly spacingMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { warn(message: string): void } | undefined;

  constructor(
    private readonly pool: SenderPool,
    private readonly simulator: TransferSimulator,
    private readonly receipts: ReceiptWaiter,
    options: ReserveAwareDispatcherOptions,
  ) {
    this.spacingMs = options.spacingMs;
    this.receiptTimeoutMs = options.receiptTimeoutMs;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxWaitMs = options.maxWaitMs ?? options.receiptTimeoutMs + options.spacingMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  async send(to: Address, valueWei: bigint, gasLimit: bigint): Promise<ConfirmedSend> {
    const reverted: Hash[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const sender = await this.acquire();
      try {
        if (await this.simulationSaysReserve(sender, to, valueWei, gasLimit)) continue;

        // A broadcast failure propagates: like SenderPool, never retried on
        // another key (out of MON or RPC down would fail there too).
        const sent = await sender.send(to, valueWei, gasLimit);
        let status: 'success' | 'reverted';
        try {
          status = await this.receipts.waitForReceipt({
            hash: sent.hash,
            timeoutMs: this.receiptTimeoutMs,
          });
        } catch (error) {
          throw new DripUnconfirmedError(sent, error);
        }
        if (status === 'success') return { ...sent, reverted };

        reverted.push(sent.hash);
        this.logger?.warn(
          `drip ${sent.hash} from ${sender.address} reverted (attempt ${attempt}/${this.maxAttempts}); ` +
            'treating it as a reserve-balance violation and moving to another key',
        );
      } finally {
        this.release(sender);
      }
    }
    throw new ReserveBalanceBusyError(reverted);
  }

  /**
   * The next key that is not sending and whose last send is at least
   * `spacingMs` old, in rotation order. Claimed synchronously (no `await`
   * between the check and the claim), so two concurrent dispatches never get
   * the same key.
   */
  private async acquire(): Promise<DripSender> {
    const members = this.pool.members();
    if (members.length === 0) {
      throw new GasDripRefusedError(
        'faucet_unconfigured',
        'No faucet senders configured; set GAS_DRIP_PRIVATE_KEYS',
      );
    }
    const deadline = this.now() + this.maxWaitMs;
    for (;;) {
      const now = this.now();
      let wakeAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < members.length; i += 1) {
        const index = (this.cursor + i) % members.length;
        const sender = members[index] as DripSender;
        if (this.inFlight.has(sender.address)) continue;
        const last = this.pool.lastUsedAt(sender.address);
        const readyAt = last === undefined ? now : last + this.spacingMs;
        if (readyAt <= now) {
          this.cursor = (index + 1) % members.length;
          this.inFlight.add(sender.address);
          this.pool.markUsed(sender.address, now);
          return sender;
        }
        wakeAt = Math.min(wakeAt, readyAt);
      }
      if (now >= deadline) throw new ReserveBalanceBusyError([]);
      await this.sleep(Math.max(1, Math.min(wakeAt, now + POLL_MS, deadline) - now));
    }
  }

  /** Frees the key and restarts its spacing from now: after the receipt, or the failure. */
  private release(sender: DripSender): void {
    this.inFlight.delete(sender.address);
    this.pool.markUsed(sender.address, this.now());
  }

  private async simulationSaysReserve(
    sender: DripSender,
    to: Address,
    value: bigint,
    gas: bigint,
  ): Promise<boolean> {
    try {
      await this.simulator.simulateTransfer({ from: sender.address, to, value, gas });
      return false;
    } catch (error) {
      const message = describeError(error);
      if (RESERVE_VIOLATION.test(message)) {
        this.logger?.warn(
          `simulated drip from ${sender.address} hits the reserve balance; not broadcasting`,
        );
        return true;
      }
      // Advisory only: the receipt decides. An RPC hiccup here must not block a drip.
      this.logger?.warn(
        `drip simulation from ${sender.address} failed, sending anyway: ${message}`,
      );
      return false;
    }
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // viem nests the node's text: `details` on the error, or a `cause` chain.
  const details = (error as { details?: unknown }).details;
  const cause = error.cause instanceof Error ? ` (${describeError(error.cause)})` : '';
  return `${error.message}${typeof details === 'string' ? ` ${details}` : ''}${cause}`;
}
