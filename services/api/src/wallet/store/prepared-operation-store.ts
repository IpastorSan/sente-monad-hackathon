import { Injectable } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import type { SenteUserOperation } from '../bundler/bundler';
import type { AuthorizationMessage } from '../authorization/authorization';

/** DI token for the prepare -> execute handoff. */
export const PREPARED_OPERATION_STORE = Symbol('PREPARED_OPERATION_STORE');

export type PreparedOperation = {
  id: string;
  userId: string;
  owner: Address;
  sender: Address;
  /** Fully populated except for `signature`, which the client supplies. */
  userOperation: SenteUserOperation;
  userOpHash: Hash;
  authorization: AuthorizationMessage;
  sponsored: boolean;
  createdAt: Date;
  expiresAt: Date;
  /** Set once `execute` consumes it. A prepared op is single-use. */
  consumedAt?: Date;
};

/**
 * Holds prepared UserOperations between `prepare` and `execute`.
 *
 * Server-side storage rather than round-tripping the operation through the
 * client is the point: `execute` takes an id and two signatures, so there is no
 * client-supplied operation to re-validate and no chance of the submitted
 * operation differing from the hashed one. The client's own verification (it
 * re-encodes the batch and checks the callData before signing) covers the other
 * direction.
 *
 * Entries are single-use and short-lived — fees go stale, and a signature that
 * stays spendable is a signature waiting to be replayed.
 */
export interface PreparedOperationStore {
  put(operation: PreparedOperation): Promise<void>;
  /** Returns undefined for unknown, expired, or already-consumed ids. */
  take(id: string, now: Date): Promise<PreparedOperation | undefined>;
  /** For the status view: the operation this hash came from, if we still hold it. */
  findByUserOpHash(userOpHash: Hash): Promise<PreparedOperation | undefined>;
}

/** PERSISTENCE: in memory, same reasoning as `SmartAccountRegistry`. */
@Injectable()
export class InMemoryPreparedOperationStore implements PreparedOperationStore {
  private readonly byId = new Map<string, PreparedOperation>();

  put(operation: PreparedOperation): Promise<void> {
    this.sweep(operation.createdAt);
    this.byId.set(operation.id, operation);
    return Promise.resolve();
  }

  take(id: string, now: Date): Promise<PreparedOperation | undefined> {
    const found = this.byId.get(id);
    if (!found || found.consumedAt || found.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(undefined);
    }
    // Marked consumed rather than deleted, so the status view can still resolve
    // the hash after submission.
    found.consumedAt = now;
    return Promise.resolve(found);
  }

  findByUserOpHash(userOpHash: Hash): Promise<PreparedOperation | undefined> {
    for (const operation of this.byId.values()) {
      if (operation.userOpHash.toLowerCase() === userOpHash.toLowerCase()) {
        return Promise.resolve(operation);
      }
    }
    return Promise.resolve(undefined);
  }

  /** Drops entries an hour past expiry. Cheap, and bounded by request volume. */
  private sweep(now: Date): void {
    const cutoff = now.getTime() - 60 * 60 * 1000;
    for (const [id, operation] of this.byId) {
      if (operation.expiresAt.getTime() < cutoff) {
        this.byId.delete(id);
      }
    }
  }
}
