import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrivyError } from '../agents/privy/privy.client';
import { isDevicePublicKey } from '../agents/privy/user-wallet';
import type { Principal } from '../auth/principal';
import {
  TOKEN_BALANCES,
  type TokenBalance,
  type TokenBalanceReader,
} from './balances/token-balances';
import {
  USER_WALLET_REGISTRY,
  type UserWalletBinding,
  type UserWalletRegistry,
} from './store/user-wallet-registry';
import { USER_WALLETS, type UserWalletProvider } from './user-wallet.provider';
import { WalletRefusedError } from './wallet.errors';
import { WALLET_CHAIN_ID } from './wallet.service';

export type UserWalletView = UserWalletBinding & {
  chainId: number;
  balances: TokenBalance[];
};

/**
 * ---------------------------------------------------------------------------
 * THE USER'S WALLET (SEN-40, Phase 3)
 *
 * A Privy server wallet whose owner is the phone's `device` P-256 key. This
 * service creates it and reads it; it can never spend from it, and neither can
 * anything else in this process — the owner key never leaves the device, and
 * Privy enforces that on its side (docs/privy-sponsorship.md, checks 4a-4c).
 *
 * That is what replaces the Kernel smart account of `wallet.service.ts`: the
 * self-custody property is the same, but it is enforced by an enclave holding a
 * key nobody else has, rather than by an ERC-4337 validator — and Privy
 * sponsors the gas (SEN-39), so the user never needs MON to move USDC.
 *
 * REGISTRATION IS IDEMPOTENT, AND IT HAS TO BE. Unlike a Kernel account, a
 * Privy wallet's address is not derived from its owner: creating a second one
 * lands on a different address, so "register twice" must not mean "two
 * wallets". Two guards do that — the registry's first-write-wins bind, and the
 * in-flight map below, which collapses concurrent registers for the same user
 * into one provision call. Without the second, two parallel calls from a phone
 * that retried on a slow network would create two Privy wallets and bind the
 * first to win the race, orphaning the other.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class UserWalletService {
  private readonly logger = new Logger(UserWalletService.name);
  /** One in-flight registration per user. See the note above. */
  private readonly registering = new Map<string, Promise<UserWalletBinding>>();

  constructor(
    @Inject(USER_WALLETS) private readonly wallets: UserWalletProvider,
    @Inject(USER_WALLET_REGISTRY) private readonly registry: UserWalletRegistry,
    @Inject(TOKEN_BALANCES) private readonly balances: TokenBalanceReader,
  ) {}

  /**
   * Creates the caller's wallet, owned by their device key, or returns the one
   * they already have. A DIFFERENT device key for a known user is refused: see
   * `store/user-wallet-registry.ts` for why that is the safe answer.
   */
  async register(
    principal: Principal,
    command: { devicePublicKey: string },
  ): Promise<UserWalletView> {
    const devicePublicKey = command.devicePublicKey.trim();
    if (!isDevicePublicKey(devicePublicKey)) {
      throw new WalletRefusedError(
        'invalid_device_key',
        'devicePublicKey must be the base64 SPKI DER of a P-256 public key',
      );
    }

    const existing = await this.registry.find(principal.userId);
    if (existing) {
      return this.describe(this.assertSameDevice(existing, devicePublicKey));
    }

    const inflight = this.registering.get(principal.userId);
    if (inflight) {
      return this.describe(this.assertSameDevice(await inflight, devicePublicKey));
    }

    const created = this.provision(principal, devicePublicKey).finally(() => {
      this.registering.delete(principal.userId);
    });
    this.registering.set(principal.userId, created);
    return this.describe(this.assertSameDevice(await created, devicePublicKey));
  }

  /** The caller's wallet and its balances, or `account_not_registered`. */
  async account(principal: Principal): Promise<UserWalletView> {
    const binding = await this.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No wallet for this user; POST /wallet/register with the device public key first',
      );
    }
    return this.describe(binding);
  }

  private async provision(
    principal: Principal,
    devicePublicKey: string,
  ): Promise<UserWalletBinding> {
    // Names the wallet in Privy's dashboard after the user, short enough for
    // the 50-character limit and not the whole address: an EOA's last six
    // characters are plenty to tell two testnet users apart.
    const displayName = `sente-user-${principal.userId.slice(-6)}`;
    const wallet = await this.provisionOrRefuse({ devicePublicKey, displayName });

    const result = await this.registry.bind({
      userId: principal.userId,
      walletId: wallet.walletId,
      address: wallet.address,
      ownerQuorumId: wallet.ownerQuorumId,
      devicePublicKey,
    });
    if (!result.ok) {
      // Only reachable if something bound this user between the find above and
      // here. The wallet we just made is then orphaned, so say its id out loud
      // rather than dropping it silently.
      this.logger.error(
        `register raced for user=${principal.userId}: bound wallet ${result.existing.walletId}, ` +
          `orphaning freshly created ${wallet.walletId} (${wallet.address})`,
      );
      return result.existing;
    }

    this.logger.log(
      `registered user=${principal.userId} wallet=${wallet.walletId} address=${wallet.address} ` +
        `ownerQuorum=${wallet.ownerQuorumId} (owner key is on the device; this server cannot sign)`,
    );
    return result.binding;
  }

  private async provisionOrRefuse(input: { devicePublicKey: string; displayName: string }) {
    try {
      return await this.wallets.provision(input);
    } catch (error) {
      if (error instanceof WalletRefusedError) throw error;
      if (error instanceof PrivyError) {
        // Privy's own message, not a stack: the operator needs to know whether
        // it was the app secret, the key encoding, or Privy being down.
        this.logger.error(`Privy refused to create a user wallet: ${error.message}`);
        throw new WalletRefusedError(
          'user_wallet_provider_failed',
          `The wallet provider refused this request: ${error.message}`,
        );
      }
      throw error;
    }
  }

  private assertSameDevice(binding: UserWalletBinding, devicePublicKey: string): UserWalletBinding {
    if (binding.devicePublicKey === devicePublicKey) {
      return binding;
    }
    this.logger.warn(
      `register refused: user=${binding.userId} is already bound to wallet ${binding.walletId} ` +
        'under a different device key',
    );
    throw new WalletRefusedError(
      'device_key_mismatch',
      'This account already has a wallet owned by a different device key. Sign in on the ' +
        'original device; key recovery is not implemented yet.',
    );
  }

  private async describe(binding: UserWalletBinding): Promise<UserWalletView> {
    return {
      ...binding,
      chainId: WALLET_CHAIN_ID,
      balances: await this.balances.balances(binding.address),
    };
  }
}
