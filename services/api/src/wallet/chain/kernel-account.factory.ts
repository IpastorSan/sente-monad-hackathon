import {
  getAddress,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
} from 'viem';
import { toAccount } from 'viem/accounts';
import { entryPoint07Address } from 'viem/account-abstraction';
import { toKernelSmartAccount } from 'permissionless/accounts';

/** DI token for the Kernel account factory. */
export const KERNEL_ACCOUNTS = Symbol('KERNEL_ACCOUNTS');

/**
 * Kernel v0.3.1 on EntryPoint v0.7 — pinned, and pinned to the SAME values as
 * `apps/mobile/src/wallet/kernel.ts`. The address is a pure function of these
 * plus the owner, so a divergence between client and server is not a version
 * skew, it is two different accounts.
 */
export const KERNEL_VERSION = '0.3.1' as const;
export const ENTRY_POINT_ADDRESS = entryPoint07Address;
export const ENTRY_POINT_VERSION = '0.7' as const;

/**
 * The slice of a smart account the wallet service uses. Everything here is a
 * read or a local encode — nothing signs, because the server has no key.
 */
export interface KernelAccountView {
  readonly address: Address;
  isDeployed(): Promise<boolean>;
  getNonce(): Promise<bigint>;
  getFactoryArgs(): Promise<{ factory?: Address | undefined; factoryData?: Hex | undefined }>;
  encodeCalls(calls: readonly { to: Address; value?: bigint; data?: Hex }[]): Promise<Hex>;
  /**
   * A syntactically valid but meaningless signature, so gas estimation
   * simulates the real validation cost rather than a cheap early revert.
   */
  getStubSignature(): Promise<Hex>;
}

export interface KernelAccountFactory {
  /** Resolves the Kernel account owned by `owner`. One `eth_call`, then cached. */
  forOwner(owner: Address): Promise<KernelAccountView>;
}

/**
 * ---------------------------------------------------------------------------
 * A WATCH-ONLY OWNER
 *
 * The server derives the account from the owner's ADDRESS and never holds the
 * key — self-custody is the whole point, and the Mera key exists only inside a
 * live session on the user's device. `toKernelSmartAccount` needs an "owner"
 * object, but for an ECDSA owner it only ever reads `.address` (the validator's
 * init data is literally the owner address). So it gets an account whose
 * signing methods throw.
 *
 * If a future change makes the server reach for one of these, it fails loudly
 * here rather than quietly signing with something it should not have.
 * ---------------------------------------------------------------------------
 */
function watchOnlyOwner(address: Address) {
  const refuse = (): never => {
    throw new Error('The API has no signing key for a user wallet; the client is the only signer');
  };
  return toAccount({
    address: getAddress(address),
    signMessage: () => Promise.resolve(refuse()),
    signTransaction: () => Promise.resolve(refuse()),
    signTypedData: () => Promise.resolve(refuse()),
  });
}

/**
 * The exact client shape `toKernelSmartAccount` accepts. Spelled out rather
 * than inferred so a plain `PublicClient` cannot be passed where the account
 * union matters.
 */
export type KernelDerivationClient = Client<
  Transport,
  Chain | undefined,
  JsonRpcAccount | LocalAccount | undefined
>;

export class PermissionlessKernelAccountFactory implements KernelAccountFactory {
  private readonly cache = new Map<string, Promise<KernelAccountView>>();

  constructor(private readonly client: KernelDerivationClient) {}

  forOwner(owner: Address): Promise<KernelAccountView> {
    const key = owner.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const built = this.build(owner).catch((error: unknown) => {
      // Do not cache a failed derivation: the next request should retry rather
      // than inherit a transient RPC failure forever.
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, built);
    return built;
  }

  private async build(owner: Address): Promise<KernelAccountView> {
    const account = await toKernelSmartAccount({
      client: this.client,
      entryPoint: { address: ENTRY_POINT_ADDRESS, version: ENTRY_POINT_VERSION },
      owners: [watchOnlyOwner(owner)],
      version: KERNEL_VERSION,
    });
    return {
      address: account.address,
      isDeployed: () => account.isDeployed(),
      getNonce: () => account.getNonce(),
      getFactoryArgs: () => account.getFactoryArgs(),
      encodeCalls: (calls) => account.encodeCalls([...calls]),
      getStubSignature: () => account.getStubSignature(),
    };
  }
}
