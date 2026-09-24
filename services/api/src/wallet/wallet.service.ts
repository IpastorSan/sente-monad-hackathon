import { randomUUID, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress, type Address, type Hash, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';

import type { Principal } from '../auth/principal';
import {
  authorizationPayload,
  executeBodyHash,
  verifyAuthorization,
  type AuthorizationMessage,
  type AuthorizationPayload,
} from './authorization/authorization';
import { BUNDLER, type Bundler, type SenteUserOperation } from './bundler/bundler';
import {
  ENTRY_POINT_ADDRESS,
  ENTRY_POINT_VERSION,
  KERNEL_ACCOUNTS,
  type KernelAccountFactory,
} from './chain/kernel-account.factory';
import {
  OPERATION_TRACKER,
  type OperationTracker,
  type TrackedOperation,
} from './confirmation/operation-tracker';
import {
  SPONSORSHIP,
  SponsorshipUnavailableError,
  type Sponsorship,
} from './paymaster/sponsorship';
import { SEND_CHAIN_ID } from './send/sponsored-send';
import {
  PREPARED_OPERATION_STORE,
  type PreparedOperation,
  type PreparedOperationStore,
} from './store/prepared-operation-store';
import {
  SMART_ACCOUNT_REGISTRY,
  type SmartAccountBinding,
  type SmartAccountRegistry,
} from './store/smart-account-registry';
import { WALLET_CONFIG, type WalletConfig } from './wallet.config';
import { WalletRefusedError } from './wallet.errors';

/** The chain every wallet in this service lives on. Matches `gas/`. */
/**
 * Monad testnet, defined once for the whole module: `send/sponsored-send.ts`
 * needs it without importing this file (it is loaded by the live probes under
 * node's type stripping, and this one carries Nest decorators), so the constant
 * lives there and this is the alias every older caller already uses.
 */
export const WALLET_CHAIN_ID = SEND_CHAIN_ID;

/** The endpoint the authorization envelope is bound to. */
export const EXECUTE_ROUTE = { method: 'POST', path: '/wallet/execute' } as const;

export type WalletCall = { to: Address; value?: bigint; data?: Hex };

export type WalletAccountView = SmartAccountBinding & {
  deployed: boolean;
  sponsorshipAvailable: boolean;
};

export type PrepareCommand = {
  calls: readonly WalletCall[];
  /** Optional and never trusted. Compared against the canonical sender. */
  sender?: string;
};

export type PrepareResult = {
  prepareId: string;
  chainId: number;
  entryPoint: Address;
  sender: Address;
  owner: Address;
  userOperation: SenteUserOperation;
  userOpHash: Hash;
  sponsored: boolean;
  expiresAt: Date;
  authorization: AuthorizationPayload;
};

export type ExecuteCommand = {
  prepareId: string;
  userOpSignature: Hex;
  authorizationSignature: Hex;
};

export type ExecuteResult = {
  userOpHash: Hash;
  status: TrackedOperation['status'];
  sponsored: boolean;
};

/**
 * ---------------------------------------------------------------------------
 * PREPARE -> SIGN -> EXECUTE
 *
 * Two things that sound contradictory, both required:
 *
 *   THE SERVER ORCHESTRATES. It resolves the account, builds the calldata,
 *   injects fees, and pays for gas — because the client is untrusted and none
 *   of that may be client-supplied.
 *
 *   THE CLIENT IS THE ONLY SIGNER. Self-custody means the API cannot move a
 *   user's funds on its own, and it holds no key that could (see
 *   `chain/kernel-account.factory.ts`).
 *
 * They reconcile because the signature is bound to exactly what gets submitted:
 * the UserOperation signature covers the operation, and the EIP-712
 * authorization envelope covers the endpoint, the body and the owner identity
 * (see `authorization/authorization.ts`).
 *
 * This is `eth_signUserOperation`-shaped, never `eth_sendTransaction`-shaped:
 * we sign and broadcast as two separate steps. `docs/privy-policy-enforcement.md`
 * spells out why that matters — stateful policy aggregations (a rolling spend
 * cap) are supported ONLY on the signing methods, and the sign-and-broadcast
 * path is the one place a pre-flight simulation runs before policy evaluation.
 * The agent wallets in a later issue depend on that property; establishing the
 * pattern here keeps it consistent.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(WALLET_CONFIG) private readonly config: WalletConfig,
    @Inject(SMART_ACCOUNT_REGISTRY) private readonly registry: SmartAccountRegistry,
    @Inject(PREPARED_OPERATION_STORE) private readonly prepared: PreparedOperationStore,
    @Inject(KERNEL_ACCOUNTS) private readonly kernelAccounts: KernelAccountFactory,
    @Inject(BUNDLER) private readonly bundler: Bundler,
    @Inject(SPONSORSHIP) private readonly sponsorship: Sponsorship,
    @Inject(OPERATION_TRACKER) private readonly tracker: OperationTracker,
  ) {}

  /**
   * Binds the authenticated user to their owner key and returns the smart
   * account it derives.
   *
   * First write wins. The address is a pure function of the owner, so a second,
   * different owner for the same user is a different account — a bug or an
   * attack, never a re-registration.
   */
  async register(principal: Principal, ownerInput: string): Promise<WalletAccountView> {
    if (!isAddress(ownerInput)) {
      throw new WalletRefusedError('owner_conflict', 'owner must be a 20-byte hex address');
    }
    const owner = getAddress(ownerInput);
    const account = await this.kernelAccounts.forOwner(owner);

    const result = await this.registry.bind({
      userId: principal.userId,
      owner,
      address: account.address,
    });
    if (!result.ok) {
      this.logger.warn(
        `register refused: user=${principal.userId} is already bound to owner ` +
          `${result.existing.owner}, request offered ${owner}`,
      );
      throw new WalletRefusedError(
        'owner_conflict',
        'This account is already bound to a different owner key',
      );
    }

    if (result.created) {
      this.logger.log(
        `registered user=${principal.userId} owner=${owner} smartAccount=${account.address}`,
      );
    }
    return this.describe(result.binding);
  }

  /** The caller's account, or `account_not_registered`. */
  async account(principal: Principal): Promise<WalletAccountView> {
    return this.describe(await this.requireBinding(principal));
  }

  /**
   * Builds a fully-populated, sponsored UserOperation and the envelope the
   * client must sign. Nothing is broadcast here.
   */
  async prepare(principal: Principal, command: PrepareCommand): Promise<PrepareResult> {
    const binding = await this.requireBinding(principal);
    this.assertCanonicalSender(principal, binding, command.sender);

    const account = await this.kernelAccounts.forOwner(binding.owner);
    if (account.address.toLowerCase() !== binding.address.toLowerCase()) {
      // Derivation drifted under a bound account — a library bump or a changed
      // constant. Refusing is the only safe answer: signing here would spend
      // from an address the user has never seen.
      this.logger.error(
        `derivation drift for user=${principal.userId}: bound ${binding.address}, ` +
          `derived ${account.address}`,
      );
      throw new WalletRefusedError(
        'sender_mismatch',
        'Smart account derivation no longer matches the bound address',
      );
    }

    const [callData, nonce, deployed, fees] = await Promise.all([
      account.encodeCalls(command.calls),
      account.getNonce(),
      account.isDeployed(),
      this.bundler.fees(),
    ]);

    // The account is deployed lazily, by its own first UserOperation: the
    // factory call rides in `initCode`, so a brand new user never needs a
    // separate deployment transaction (or the gas for one).
    const factoryArgs = deployed ? {} : await account.getFactoryArgs();

    let draft: SenteUserOperation = {
      sender: binding.address,
      nonce,
      callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: await account.getStubSignature(),
      ...(factoryArgs.factory ? { factory: factoryArgs.factory } : {}),
      ...(factoryArgs.factoryData ? { factoryData: factoryArgs.factoryData } : {}),
    } as SenteUserOperation;

    // ERC-7677 is a three-step dance for a reason: estimation has to see the
    // paymaster's own validation and postOp cost, but the real signed
    // sponsorship can only be issued once the gas limits are final.
    let sponsored = false;
    if (this.sponsorship.available) {
      try {
        draft = { ...draft, ...(await this.sponsorship.stub(draft)) };
        sponsored = true;
      } catch (error) {
        this.logger.warn(`paymaster stub declined: ${describe(error)}`);
        draft = stripPaymaster(draft);
      }
    }

    try {
      draft = { ...draft, ...(await this.bundler.estimate(draft)) };
    } catch (error) {
      const detail = describe(error);
      // `AA21 didn't pay prefund` is the single most likely failure in this
      // repo's current state and it looks like a bug until you know what it
      // means: the operation is fine, nobody has agreed to pay for it. Say so,
      // rather than making the next person read a viem stack trace.
      if (!sponsored && /AA21|prefund|sufficient funds/i.test(detail)) {
        throw new WalletRefusedError(
          'sponsorship_unavailable',
          'No paymaster is configured and the smart account holds no MON, so the bundler ' +
            'refused the operation with "AA21 didn\'t pay prefund". Set PIMLICO_BUNDLER_URL ' +
            `and PIMLICO_SPONSORSHIP_POLICY_ID to sponsor it. (${detail})`,
        );
      }
      this.logger.error(`gas estimation failed for sender=${binding.address}: ${detail}`);
      throw new WalletRefusedError('bundler_rejected', detail);
    }

    if (sponsored) {
      try {
        draft = { ...draft, ...(await this.sponsorship.quote(draft)) };
      } catch (error) {
        // Never fall through claiming sponsorship: the account would silently
        // become the payer, and it holds no MON.
        throw new WalletRefusedError(
          'sponsorship_unavailable',
          error instanceof SponsorshipUnavailableError
            ? error.message
            : `Paymaster declined this operation: ${describe(error)}`,
        );
      }
    }

    const userOpHash = getUserOperationHash({
      chainId: WALLET_CHAIN_ID,
      entryPointAddress: ENTRY_POINT_ADDRESS,
      entryPointVersion: ENTRY_POINT_VERSION,
      userOperation: draft,
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.prepareTtlMs);
    const prepareId = randomUUID();
    const authorization: AuthorizationMessage = {
      method: EXECUTE_ROUTE.method,
      path: EXECUTE_ROUTE.path,
      owner: binding.owner,
      sender: binding.address,
      userOpHash,
      bodyHash: executeBodyHash(prepareId),
      // Single-use, server-issued: a harvested signature cannot be replayed.
      nonce: `0x${randomBytes(32).toString('hex')}`,
      expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
    };

    const record: PreparedOperation = {
      id: prepareId,
      userId: principal.userId,
      owner: binding.owner,
      sender: binding.address,
      userOperation: draft,
      userOpHash,
      authorization,
      sponsored,
      createdAt: now,
      expiresAt,
    };
    await this.prepared.put(record);

    this.logger.log(
      `prepared ${prepareId} user=${principal.userId} sender=${binding.address} ` +
        `calls=${command.calls.length} deployed=${deployed} sponsored=${sponsored} ` +
        `userOpHash=${userOpHash}`,
    );

    return {
      prepareId,
      chainId: WALLET_CHAIN_ID,
      entryPoint: ENTRY_POINT_ADDRESS,
      sender: binding.address,
      owner: binding.owner,
      userOperation: draft,
      userOpHash,
      sponsored,
      expiresAt,
      authorization: authorizationPayload(WALLET_CHAIN_ID, authorization),
    };
  }

  /**
   * Verifies the client's two signatures and broadcasts.
   *
   * The operation itself comes from the store, not from the request, so there
   * is no client-supplied operation that could differ from the one that was
   * hashed and approved.
   */
  async execute(principal: Principal, command: ExecuteCommand): Promise<ExecuteResult> {
    const now = new Date();
    const record = await this.prepared.take(command.prepareId, now);
    if (!record) {
      throw new WalletRefusedError(
        'prepare_expired',
        'Unknown, expired or already-used prepare id; prepare the operation again',
      );
    }
    if (record.userId !== principal.userId) {
      this.logger.warn(
        `execute refused: user=${principal.userId} tried to execute a prepare owned by ` +
          `user=${record.userId} (sender ${record.sender})`,
      );
      throw new WalletRefusedError(
        'sender_mismatch',
        'This prepared operation belongs to a different account',
      );
    }

    // Re-derive the body hash rather than trusting the stored one, so the
    // envelope is checked against THIS request rather than against itself.
    const expected: AuthorizationMessage = {
      ...record.authorization,
      bodyHash: executeBodyHash(command.prepareId),
    };
    const valid = await verifyAuthorization({
      chainId: WALLET_CHAIN_ID,
      message: expected,
      signature: command.authorizationSignature,
      // The owner the SERVER resolved. A forged `x-sente-user-id` header cannot
      // get past this without the owner's key.
      expectedOwner: record.owner,
    });
    if (!valid) {
      this.logger.warn(
        `execute refused: authorization envelope did not verify for user=${principal.userId} ` +
          `sender=${record.sender} prepare=${command.prepareId}`,
      );
      throw new WalletRefusedError(
        'invalid_authorization',
        'The authorization signature does not match this request',
      );
    }

    const signed: SenteUserOperation = {
      ...record.userOperation,
      signature: command.userOpSignature,
    };
    let userOpHash: Hash;
    try {
      userOpHash = await this.bundler.send(signed);
    } catch (error) {
      this.logger.error(
        `bundler rejected userOp for sender=${record.sender} prepare=${command.prepareId}: ` +
          describe(error),
      );
      throw new WalletRefusedError('bundler_rejected', describe(error));
    }

    if (userOpHash.toLowerCase() !== record.userOpHash.toLowerCase()) {
      // Not fatal — the bundler is authoritative about the hash it accepted —
      // but it means the operation submitted is not the one we hashed, which is
      // worth shouting about.
      this.logger.error(
        `userOp hash mismatch: prepared ${record.userOpHash}, bundler returned ${userOpHash}`,
      );
    }

    this.tracker.track({ userOpHash, sender: record.sender, sponsored: record.sponsored });
    this.logger.log(
      `submitted ${userOpHash} user=${principal.userId} sender=${record.sender} ` +
        `sponsored=${record.sponsored}`,
    );

    return { userOpHash, status: 'pending', sponsored: record.sponsored };
  }

  /**
   * Our own view of a submitted operation — one half of the confirmation race
   * the client runs against the bundler's receipt.
   */
  async status(userOpHash: Hash): Promise<TrackedOperation> {
    const tracked = this.tracker.status(userOpHash);
    if (tracked) {
      return tracked;
    }
    const record = await this.prepared.findByUserOpHash(userOpHash);
    return {
      userOpHash,
      sender: record?.sender ?? ('0x0000000000000000000000000000000000000000' as Address),
      status: record ? 'pending' : 'unknown',
      sponsored: record?.sponsored ?? false,
      submittedAt: record?.consumedAt ?? new Date(0),
    };
  }

  private async requireBinding(principal: Principal): Promise<SmartAccountBinding> {
    const binding = await this.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No smart account for this user; POST /wallet/kernel/register with the owner address first',
      );
    }
    return binding;
  }

  /**
   * The canonical-sender check.
   *
   * The client may send a sender; it is only ever compared, never used. At
   * Charms the equivalent check closed a real bug where a stale address cached
   * on a shared device leaked across accounts — so a mismatch is logged with
   * both addresses and refused, rather than shrugged off.
   */
  private assertCanonicalSender(
    principal: Principal,
    binding: SmartAccountBinding,
    supplied: string | undefined,
  ): void {
    if (supplied === undefined) {
      return;
    }
    if (!isAddress(supplied) || getAddress(supplied) !== binding.address) {
      this.logger.warn(
        `sender mismatch for user=${principal.userId}: canonical ${binding.address}, ` +
          `client supplied ${supplied}`,
      );
      throw new WalletRefusedError(
        'sender_mismatch',
        'The supplied sender is not this account; refresh the wallet and retry',
      );
    }
  }

  private async describe(binding: SmartAccountBinding): Promise<WalletAccountView> {
    const account = await this.kernelAccounts.forOwner(binding.owner);
    return {
      ...binding,
      deployed: await account.isDeployed(),
      sponsorshipAvailable: this.sponsorship.available,
    };
  }
}

/** Removes every paymaster field, so a declined stub cannot leak into estimation. */
function stripPaymaster(userOperation: SenteUserOperation): SenteUserOperation {
  const {
    paymaster: _paymaster,
    paymasterData: _paymasterData,
    paymasterVerificationGasLimit: _verificationGas,
    paymasterPostOpGasLimit: _postOpGas,
    ...rest
  } = userOperation;
  return rest as SenteUserOperation;
}

/**
 * Error text fit for a response body and a log line.
 *
 * viem's account-abstraction errors are several hundred lines — the full
 * UserOperation, every gas field, a docs link. Useful in a stack trace, useless
 * in JSON, so keep the first paragraph (the short message) and cap the rest.
 */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstParagraph = raw.split('\n\n')[0] ?? raw;
  const detail = / Details: (.+)/.exec(raw)?.[1];
  const combined = detail ? `${firstParagraph} (${detail})` : firstParagraph;
  return combined.length > 400 ? `${combined.slice(0, 400)}...` : combined;
}
