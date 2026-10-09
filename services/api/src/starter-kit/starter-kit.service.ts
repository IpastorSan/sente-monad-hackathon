import { erc20Abi, encodeFunctionData, formatUnits, type Address, type Hash, type Hex } from 'viem';

import type { StarterKitConfig, StarterKitToken } from './starter-kit.config';
import type { StarterKitStore } from './starter-kit.store';

/** DI token for what `UserWalletService` calls after a register. */
export const STARTER_KIT = Symbol('STARTER_KIT');

export type StarterKitStatus = 'none' | 'pending' | 'sent' | 'failed' | 'disabled';

/** What `GET /wallet` says about the user's starter kit. */
export interface StarterKitView {
  status: StarterKitStatus;
  ausdTx?: Hash;
  usdcTx?: Hash;
}

/** The seam `UserWalletService` depends on. */
export interface StarterKit {
  /**
   * Sends `address` its starter kit if `userId` never had one. Fire-and-forget:
   * the returned promise settles when the sends do and never rejects, and the
   * caller does not wait for it.
   */
  grant(userId: string, address: Address): Promise<void>;
  status(userId: string): StarterKitView;
}

/** One nonce-managed key. `NonceManagedSender` is the implementation. */
export interface StarterKitSender {
  readonly address: Address;
  send(to: Address, valueWei: bigint, gasLimit: bigint, data: Hex): Promise<{ hash: Hash }>;
}

/** The two reads the kit needs. Narrow, so the spec fakes it in a few lines. */
export interface StarterKitChain {
  balanceOf(token: Address, holder: Address): Promise<bigint>;
  /** Rejects on timeout or RPC failure. */
  waitForReceipt(hash: Hash, timeoutMs: number): Promise<'success' | 'reverted'>;
}

interface Log {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * ---------------------------------------------------------------------------
 * THE STARTER KIT (SEN-170)
 *
 * A new user's wallet gets AUSD and USDC once, so a judge can hire an agent
 * without hunting faucets: Perpl needs 100 AUSD to open an account and Kuru's
 * minimum notional is 10 USDC.
 *
 * - ONCE PER USER, ever. `StarterKitStore.claim` is the gate, and it is
 *   synchronous, so concurrent registers cannot both pass it. With `STATE_DIR`
 *   set it survives a redeploy.
 * - NEVER IN THE REGISTER'S WAY. `grant` is not awaited, never rejects, and
 *   everything it can fail at is recorded as `failed` instead of thrown.
 * - ONE SENDER, SEQUENTIAL. Both transfers go from one nonce-managed key, the
 *   second only after the first's receipt; a reverted or unconfirmed transfer
 *   ends the kit as `failed`, with no retry: a retry could pay twice, and
 *   every revert is charged its full gas limit (CLAUDE.md gotcha 4).
 * - BALANCES FIRST. The sender's balance of both tokens is read before
 *   anything is sent, so an empty starter wallet fails without spending gas
 *   and never sends half a kit.
 *
 * Monad's reserve balance (gotcha 12) bounds MON transfers, and these are
 * token transfers with zero value; spacing them by a receipt is all the
 * dispatcher's caution they need.
 * ---------------------------------------------------------------------------
 */
export class StarterKitService implements StarterKit {
  readonly #config: StarterKitConfig;
  readonly #store: StarterKitStore;
  readonly #sender: StarterKitSender | null;
  readonly #chain: StarterKitChain | null;
  readonly #log: Log;
  readonly #now: () => Date;

  constructor(deps: {
    config: StarterKitConfig;
    store: StarterKitStore;
    sender: StarterKitSender | null;
    chain: StarterKitChain | null;
    log: Log;
    now?: () => Date;
  }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#sender = deps.sender;
    this.#chain = deps.chain;
    this.#log = deps.log;
    this.#now = deps.now ?? (() => new Date());
  }

  status(userId: string): StarterKitView {
    const record = this.#store.find(userId);
    if (!record) return { status: this.#config.enabled ? 'none' : 'disabled' };
    return {
      status: record.status,
      ...(record.txs.AUSD ? { ausdTx: record.txs.AUSD } : {}),
      ...(record.txs.USDC ? { usdcTx: record.txs.USDC } : {}),
    };
  }

  async grant(userId: string, address: Address): Promise<void> {
    const config = this.#config;
    const sender = this.#sender;
    const chain = this.#chain;
    if (!config.enabled || !sender || !chain) return;
    try {
      const claim = this.#store.claim(userId, address, config.dailyCapUsers, this.#now());
      if (claim === 'exists') return;
      if (claim === 'capped') {
        this.#log.warn(
          `starter kit cap of ${config.dailyCapUsers} users today is spent; user=${userId} ` +
            'gets none until it resets (00:00 UTC) and they register again',
        );
        return;
      }
      await this.#send(sender, chain, userId, address, config.tokens, config.receiptTimeoutMs);
    } catch (error) {
      // Last line of defence: nothing here may reach the register.
      this.#fail(userId, `threw: ${describe(error)}`);
    }
  }

  async #send(
    sender: StarterKitSender,
    chain: StarterKitChain,
    userId: string,
    to: Address,
    tokens: readonly StarterKitToken[],
    timeoutMs: number,
  ): Promise<void> {
    const balances = await Promise.all(
      tokens.map((token) => chain.balanceOf(token.address, sender.address)),
    );
    for (const [index, token] of tokens.entries()) {
      const held = balances[index] ?? 0n;
      if (held < token.atoms) {
        this.#fail(
          userId,
          `starter wallet ${sender.address} holds ${formatUnits(held, token.decimals)} ` +
            `${token.symbol}, needs ${formatUnits(token.atoms, token.decimals)}; nothing was sent`,
        );
        return;
      }
    }

    const txs: Partial<Record<StarterKitToken['symbol'], Hash>> = {};
    for (const token of tokens) {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, token.atoms],
      });
      const { hash } = await sender.send(token.address, 0n, token.gasLimit, data);
      txs[token.symbol] = hash;
      this.#store.update(userId, { txs: { ...txs } }, this.#now());

      let outcome: 'success' | 'reverted';
      try {
        outcome = await chain.waitForReceipt(hash, timeoutMs);
      } catch (error) {
        this.#fail(userId, `${token.symbol} transfer ${hash} unconfirmed: ${describe(error)}`);
        return;
      }
      if (outcome !== 'success') {
        this.#fail(userId, `${token.symbol} transfer ${hash} reverted`);
        return;
      }
    }

    this.#store.update(userId, { status: 'sent' }, this.#now());
    this.#log.log(
      `starter kit sent to user=${userId} ${to}: ` +
        tokens.map((token) => `${token.symbol} ${txs[token.symbol]}`).join(', '),
    );
  }

  /** Records the kit as failed, for good, and says why in the log. */
  #fail(userId: string, reason: string): void {
    this.#log.error(`starter kit for user=${userId} failed: ${reason}`);
    try {
      this.#store.update(userId, { status: 'failed', reason: reason.slice(0, 500) }, this.#now());
    } catch (error) {
      this.#log.error(`could not record the starter kit failure for ${userId}: ${describe(error)}`);
    }
  }
}

/** The first line of an error's message, for a log line or a stored reason. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.name;
  return String(error);
}
