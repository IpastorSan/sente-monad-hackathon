import { getAddress, type Address } from 'viem';

import { createUserWallet } from '../agents/privy/user-wallet';
import type { PrivyClient } from '../agents/privy/privy.client';
import { WalletRefusedError } from './wallet.errors';

/** DI token for whatever provisions the user's wallet. */
export const USER_WALLETS = Symbol('USER_WALLETS');

export interface ProvisionUserWalletInput {
  /** base64 SPKI DER of the phone's P-256 `device` key. Becomes the OWNER. */
  devicePublicKey: string;
  displayName: string;
}

export interface ProvisionedUserWallet {
  walletId: string;
  address: Address;
  ownerQuorumId: string;
}

/**
 * Provisioning only — there is no `sign` on this interface, and that absence is
 * the design (see `agents/privy/user-wallet.ts`). The server creates the wallet
 * and then cannot use it: the owner key is on the phone, and Privy checks the
 * owner's signature on its side.
 */
export interface UserWalletProvider {
  readonly name: string;
  provision(input: ProvisionUserWalletInput): Promise<ProvisionedUserWallet>;
}

/** Privy server wallets, owned by a 1-key quorum holding the device key. */
export class PrivyUserWalletProvider implements UserWalletProvider {
  readonly name = 'privy';
  readonly #client: PrivyClient;

  constructor(client: PrivyClient) {
    this.#client = client;
  }

  async provision(input: ProvisionUserWalletInput): Promise<ProvisionedUserWallet> {
    const { wallet, ownerQuorumId } = await createUserWallet(this.#client, input);
    // Privy's casing is its own; every address that leaves this API is EIP-55.
    return { walletId: wallet.id, address: getAddress(wallet.address), ownerQuorumId };
  }
}

/**
 * What the API binds when Privy is not configured, so it still boots — the same
 * call `paymaster/` and `agents/` make. Refusing loudly beats a module that
 * silently is not there.
 */
export class UnconfiguredUserWalletProvider implements UserWalletProvider {
  readonly name = 'unconfigured';

  provision(): Promise<ProvisionedUserWallet> {
    return Promise.reject(
      new WalletRefusedError(
        'user_wallets_unconfigured',
        'Privy is not configured, so no user wallet can be created. Set PRIVY_APP_ID and ' +
          'PRIVY_APP_SECRET.',
      ),
    );
  }
}
