import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import type { Bundler } from '../bundler/bundler';

/** DI token for the confirmation tracker. */
export const OPERATION_TRACKER = Symbol('OPERATION_TRACKER');

export type OperationStatus = 'pending' | 'included' | 'reverted' | 'unknown';

export type TrackedOperation = {
  userOpHash: Hash;
  sender: Address;
  status: OperationStatus;
  sponsored: boolean;
  submittedAt: Date;
  transactionHash?: Hash;
  blockNumber?: bigint;
  actualGasCost?: bigint;
};

export interface OperationTracker {
  /** Starts polling for `userOpHash` and records it as pending. Idempotent. */
  track(operation: Pick<TrackedOperation, 'userOpHash' | 'sender' | 'sponsored'>): void;
  /** Our own view. `unknown` when we never submitted this hash. */
  status(userOpHash: Hash): TrackedOperation | undefined;
}

export type OperationTrackerOptions = {
  /**
   * Poll interval.
   *
   * 300ms — Monad's block time. The Charms version of this used 200ms because
   * Base ships flash blocks at that cadence; copying that number here would
   * just mean roughly a third more requests for no earlier answer.
   */
  pollMs: number;
  /** Give up chasing after this. The operation may still land later. */
  timeoutMs: number;
};

/**
 * ---------------------------------------------------------------------------
 * THE CONFIRMATION RACE, SERVER HALF
 *
 * The client polls two sources in parallel and takes whichever answers first:
 * the bundler's `eth_getUserOperationReceipt`, and this status view. They are
 * not redundant — the bundler is authoritative and richer, while this one is
 * always available (it survives a bundler indexer lagging, and it is the only
 * source when the client has no bundler URL configured at all).
 *
 * THE FOOTGUN THIS EXISTS TO AVOID: a UserOperation can revert INSIDE a bundle
 * transaction that itself succeeds. A status view built on the transaction
 * receipt would call that confirmed. So `included` here is set only from the
 * UserOperationEvent's own `success` flag; anything else is `reverted`.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class PollingOperationTracker implements OperationTracker, OnModuleDestroy {
  private readonly logger = new Logger(PollingOperationTracker.name);
  private readonly operations = new Map<string, TrackedOperation>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private destroyed = false;

  constructor(
    private readonly bundler: Bundler,
    private readonly options: OperationTrackerOptions,
  ) {}

  track(operation: Pick<TrackedOperation, 'userOpHash' | 'sender' | 'sponsored'>): void {
    const key = operation.userOpHash.toLowerCase();
    if (this.operations.has(key)) {
      return;
    }
    this.operations.set(key, {
      ...operation,
      status: 'pending',
      submittedAt: new Date(),
    });
    this.schedule(key, Date.now() + this.options.timeoutMs);
  }

  status(userOpHash: Hash): TrackedOperation | undefined {
    return this.operations.get(userOpHash.toLowerCase());
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(key: string, deadline: number): void {
    if (this.destroyed) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.poll(key, deadline);
    }, this.options.pollMs);
    // Never hold the process open for a poll loop.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async poll(key: string, deadline: number): Promise<void> {
    const tracked = this.operations.get(key);
    if (!tracked || tracked.status !== 'pending' || this.destroyed) {
      return;
    }

    try {
      const receipt = await this.bundler.receipt(tracked.userOpHash);
      if (receipt) {
        // `receipt.success` is the UserOperationEvent's own flag, NOT the bundle
        // transaction's status. See the class comment.
        this.operations.set(key, {
          ...tracked,
          status: receipt.success ? 'included' : 'reverted',
          transactionHash: receipt.receipt.transactionHash,
          blockNumber: receipt.receipt.blockNumber,
          actualGasCost: receipt.actualGasCost,
        });
        this.logger.log(
          `userOp ${tracked.userOpHash} ${receipt.success ? 'included' : 'REVERTED'} ` +
            `tx=${receipt.receipt.transactionHash} block=${receipt.receipt.blockNumber} ` +
            `gasCost=${receipt.actualGasCost} sponsored=${tracked.sponsored}`,
        );
        return;
      }
    } catch (error) {
      // Keep polling: a transient bundler error is not a verdict.
      this.logger.debug(`receipt poll failed for ${tracked.userOpHash}: ${describe(error)}`);
    }

    if (Date.now() >= deadline) {
      // Deliberately left `pending`, not marked failed. An operation that has
      // not surfaced inside the timeout may still land minutes later, and
      // calling it failed would be a lie the client would act on.
      this.logger.warn(
        `stopped chasing userOp ${tracked.userOpHash} after ${this.options.timeoutMs}ms; ` +
          'it is still pending, not failed',
      );
      return;
    }
    this.schedule(key, deadline);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
