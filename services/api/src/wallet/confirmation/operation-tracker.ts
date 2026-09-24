import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import type { Bundler } from '../bundler/bundler';
import type { UserOperationOutcome } from './user-operation-logs';

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
  /**
   * A SECOND source for the same question, asked only when the bundler has
   * nothing (SEN-42).
   *
   * `eth_getUserOperationReceipt` is a bundler method, and a Privy-sponsored
   * send is bundled by Privy's provider rather than by ours. Pimlico's public
   * endpoint does answer for those (measured — docs/privy-sponsorship.md, run 3,
   * check 5b), so this is a fallback and not the primary; but "our confirmation
   * view depends on another vendor's indexer" is a bad thing to be one outage
   * away from, and the EntryPoint's own event is on chain regardless.
   * `confirmation/user-operation-logs.ts` reads it.
   */
  chainReceipts?: (userOpHash: Hash) => Promise<UserOperationOutcome | null>;
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

  /**
   * The operation's outcome from whichever source has it, or `null` for "not
   * yet".
   *
   * The bundler first, because its receipt is richer and it is usually first.
   * The chain second, and only when the bundler has nothing: the EntryPoint's
   * event is the same verdict from a source that cannot be missing it.
   */
  private async read(userOpHash: Hash): Promise<
    | (Pick<TrackedOperation, 'status' | 'transactionHash' | 'blockNumber' | 'actualGasCost'> & {
        source: 'bundler' | 'chain';
      })
    | undefined
  > {
    const receipt = await this.bundler.receipt(userOpHash);
    if (receipt) {
      return {
        status: receipt.success ? 'included' : 'reverted',
        transactionHash: receipt.receipt.transactionHash,
        blockNumber: receipt.receipt.blockNumber,
        actualGasCost: receipt.actualGasCost,
        source: 'bundler',
      };
    }
    const onChain = await this.options.chainReceipts?.(userOpHash);
    if (onChain) {
      return {
        status: onChain.success ? 'included' : 'reverted',
        transactionHash: onChain.transactionHash,
        blockNumber: onChain.blockNumber,
        actualGasCost: onChain.actualGasCost,
        source: 'chain',
      };
    }
    return undefined;
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
      const settled = await this.read(tracked.userOpHash);
      if (settled) {
        const { source, ...outcome } = settled;
        // `status` is the UserOperationEvent's own `success` flag, NOT the bundle
        // transaction's status. See the class comment.
        this.operations.set(key, { ...tracked, ...outcome });
        this.logger.log(
          `userOp ${tracked.userOpHash} ${outcome.status === 'included' ? 'included' : 'REVERTED'} ` +
            `tx=${outcome.transactionHash} block=${outcome.blockNumber} ` +
            `gasCost=${outcome.actualGasCost} sponsored=${tracked.sponsored} via=${source}`,
        );
        return;
      }
    } catch (error) {
      // Keep polling: a transient error at either source is not a verdict.
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
