import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { getAddress, type Address, type Hex } from 'viem';

/**
 * ---------------------------------------------------------------------------
 * THE CHALLENGE
 *
 * The phone proves it holds the key for an address by signing a string the
 * SERVER chose. Everything that makes that proof worth anything is in this
 * file: the nonce is 32 random bytes, it lives five minutes, and it is spent
 * the first time a signature is checked against it — take() removes it whether
 * or not the signature turns out to be valid, so a harvested signature is
 * worthless the instant it has been presented once.
 *
 * The message is plain EIP-191 text rather than typed data because the user may
 * one day read it in a wallet prompt, and because the client signs the exact
 * string the server returned: there is no second place the format is written
 * down, so there is nothing for the two sides to disagree about.
 * ---------------------------------------------------------------------------
 */
export const CHALLENGE_STORE = Symbol('CHALLENGE_STORE');

export interface Challenge {
  /** Lowercase address the signature must recover to. The store key's other half. */
  address: string;
  /** 32 random bytes, 0x-prefixed. Single use. */
  nonce: Hex;
  /** Exactly what the client must sign. */
  message: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function newNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * The signed text. Checksummed address, ISO timestamp, one field per line.
 *
 * Do not reformat: an older app build signs the string its server sent it, so
 * changing this only ever affects challenges issued after the change — but a
 * client that reconstructs the message itself would break, which is precisely
 * why no client does.
 */
export function buildChallengeMessage(address: Address, nonce: Hex, issuedAt: Date): string {
  return [
    'Sente sign-in',
    `address: ${getAddress(address)}`,
    `nonce: ${nonce}`,
    `issued: ${issuedAt.toISOString()}`,
  ].join('\n');
}

export function newChallenge(address: Address, ttlS: number, now: Date = new Date()): Challenge {
  const nonce = newNonce();
  return {
    address: address.toLowerCase(),
    nonce,
    message: buildChallengeMessage(address, nonce, now),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlS * 1000),
  };
}

/**
 * Holds issued challenges until they are spent or expire.
 *
 * PERSISTENCE: in memory, same reasoning as `InMemoryPreparedOperationStore` —
 * this repo has no database yet. Point the token at a shared store and nothing
 * else changes; a challenge outliving one process is not a requirement, since
 * the client can always ask for another.
 */
export interface ChallengeStore {
  /** Stores the address's outstanding challenge, replacing any earlier one. */
  put(challenge: Challenge): Promise<void>;
  /** Removes and returns it. Undefined when there is none, or it has expired. */
  take(address: string, now: Date): Promise<Challenge | undefined>;
}

/**
 * One outstanding challenge per address, keyed by the lowercase address.
 *
 * Keyed by address rather than by nonce because `POST /auth/session` carries
 * only the address and the signature: the server, not the client, says which
 * message was signed. Asking for a second challenge abandons the first, which
 * is the same guarantee from the other side — at most one nonce for an address
 * is ever spendable.
 */
@Injectable()
export class InMemoryChallengeStore implements ChallengeStore {
  private readonly byAddress = new Map<string, Challenge>();

  put(challenge: Challenge): Promise<void> {
    this.sweep(challenge.issuedAt);
    this.byAddress.set(challenge.address, challenge);
    return Promise.resolve();
  }

  take(address: string, now: Date): Promise<Challenge | undefined> {
    const key = address.toLowerCase();
    const found = this.byAddress.get(key);
    // Spent on presentation, not on success: a signature that has been offered
    // once must never be accepted again, however it was rejected.
    if (found) this.byAddress.delete(key);

    if (!found || found.expiresAt.getTime() <= now.getTime()) return Promise.resolve(undefined);
    return Promise.resolve(found);
  }

  /** Drops expired entries. Cheap, and bounded by how many challenges were issued. */
  private sweep(now: Date): void {
    for (const [key, challenge] of this.byAddress) {
      if (challenge.expiresAt.getTime() <= now.getTime()) this.byAddress.delete(key);
    }
  }
}
