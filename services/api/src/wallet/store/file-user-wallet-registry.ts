// The user-wallet registry, on disk (SEN-48).
//
// Same semantics as `InMemoryUserWalletRegistry` — first-write-wins on
// `userId`, a different device key refused — and the spec beside this file runs
// both implementations through one table so they cannot drift apart. The only
// difference is that this one survives a restart, which for THIS store is not a
// nicety: a Privy wallet's address is not a function of its owner key, so a
// forgotten binding does not mean "register again", it means a second wallet
// and a funded first one that nothing in the product can reach.
//
// Not a Nest provider and not decorated, on purpose: `wallet.module.ts`
// constructs it, and `scripts/privy-wallets-recover.ts` loads this exact file
// under node's type stripping, which accepts no decorators (CLAUDE.md
// gotcha 10). Hence the `.ts` specifiers and the erasable syntax.

import { JsonRecordFile } from '../../state/json-file.ts';
import type {
  UserWalletBindResult,
  UserWalletBinding,
  UserWalletRegistry,
} from './user-wallet-registry.ts';

export class FileUserWalletRegistry implements UserWalletRegistry {
  readonly #file: JsonRecordFile<UserWalletBinding>;
  readonly #byUserId: Map<string, UserWalletBinding>;

  /** Loads the file eagerly, so a boot on an unreadable state file fails at boot. */
  constructor(path: string) {
    this.#file = new JsonRecordFile<UserWalletBinding>(path);
    this.#byUserId = new Map(this.#file.load().map((binding) => [binding.userId, binding]));
  }

  /** The file behind this registry. Logged at boot so the operator knows what a restart will read. */
  get path(): string {
    return this.#file.path;
  }

  /** How many bindings came back from disk. Logged at boot. */
  get size(): number {
    return this.#byUserId.size;
  }

  find(userId: string): Promise<UserWalletBinding | undefined> {
    return Promise.resolve(this.#byUserId.get(userId));
  }

  bind(binding: Omit<UserWalletBinding, 'createdAt'>): Promise<UserWalletBindResult> {
    const existing = this.#byUserId.get(binding.userId);
    if (existing) {
      // Exact string compare, as in the in-memory registry: both halves are the
      // canonical base64 SPKI DER `authorization-key.ts` produces.
      const sameKey = existing.devicePublicKey === binding.devicePublicKey;
      const result: UserWalletBindResult = sameKey
        ? { ok: true, binding: existing, created: false }
        : { ok: false, existing };
      return Promise.resolve(result);
    }

    const created: UserWalletBinding = { ...binding, createdAt: new Date() };
    this.#byUserId.set(binding.userId, created);
    try {
      // Write through BEFORE answering. A caller told `created: true` has a
      // Privy wallet in hand; it must not be possible for a restart to disagree.
      this.#file.save([...this.#byUserId.values()]);
    } catch (error) {
      // A binding we could not persist is worse than no binding: it would serve
      // one wallet until the next restart and a different one after. Undo it and
      // let the failure reach the caller.
      this.#byUserId.delete(binding.userId);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve({ ok: true, binding: created, created: true });
  }
}
