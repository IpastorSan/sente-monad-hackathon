/**
 * ONE WRITE AT A TIME PER KEY, WITH A FLOOR BETWEEN THEM.
 *
 * The same mechanism two very different places need, which is why it lives here
 * rather than in either of them:
 *
 * - **the agent runner** (SEN-8, `agents/runner/write-spacing.ts`): Privy's
 *   rolling-cap aggregation is enforced late, so two signs fired back to back
 *   can both pass a cap only one of them fits under.
 * - **a user's sponsored send** (SEN-42, `wallet/user-wallet.service.ts`): the
 *   first sponsored send EIP-7702-delegates the wallet and bumps its nonce, so a
 *   send composed before that lands is refused outright.
 *
 * Both are "the previous write has to have SETTLED, not merely been asked for",
 * so the floor is counted from the previous write's END — like
 * `GAS_DRIP_SENDER_SPACING_MS` in `gas/sender/reserve-aware-dispatcher.ts`, and
 * for the same reason: the far side records the write when it happens, not when
 * it was requested.
 *
 * It is a floor, not a delay: a key that last wrote long ago waits not at all.
 * And it is per key, so two users never wait for each other.
 *
 * Erasable syntax only and no Nest import (CLAUDE.md gotcha 10): the runner and
 * the SEN-42 send probe both reach this file under node's type stripping.
 */

export interface WriteSpacerOptions {
  readonly spacingMs: number;
  readonly now?: () => number;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class WriteSpacer {
  readonly spacingMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Per key: when its last write finished (epoch ms). */
  readonly #lastEnd = new Map<string, number>();
  /** Per key: the tail of its queue of writes. Deleted once it settles. */
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: WriteSpacerOptions) {
    this.spacingMs = options.spacingMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  /**
   * Runs `task` once every earlier write for `key` has finished and `spacingMs`
   * has passed since the last one ended. Rejects, without running `task`, if
   * `signal` aborts while it waits.
   *
   * A FAILED write still marks the key: a refusal is exactly the state the next
   * attempt must not be fired into immediately.
   */
  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const last = this.#lastEnd.get(key);
      const wait = last === undefined ? 0 : last + this.spacingMs - this.#now();
      if (wait > 0) await this.#sleep(wait, signal);
      if (signal?.aborted) throw new Error('aborted');
      try {
        return await task();
      } finally {
        this.#lastEnd.set(key, this.#now());
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
