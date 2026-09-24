import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatUnits, getAddress, isAddressEqual, type Address, type Hash } from 'viem';
import type { AuthorizationPayload } from '@sente/mandate';

import { PREPARED_APPROVAL_TTL_MS, PreparedApprovals } from '../agents/prepared-approval';
import { PrivyError } from '../agents/privy/privy.client';
import { isDevicePublicKey } from '../agents/privy/user-wallet';
import { AGENT_STORE, type AgentStore } from '../agents/store/agent-store';
import type { Principal } from '../auth/principal';
import {
  TOKEN_BALANCES,
  type BalanceToken,
  type TokenBalance,
  type TokenBalanceReader,
} from './balances/token-balances';
import { OPERATION_TRACKER, type OperationTracker } from './confirmation/operation-tracker';
import {
  SEND_CHAIN_ID,
  sendableToken,
  sponsoredTransferTransaction,
  type SponsoredSendOutcome,
} from './send/sponsored-send';
import { WriteSpacer } from '../spacing/write-spacer';
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

/** DI token for the per-wallet spacing between sponsored sends. */
export const SEND_SPACER = Symbol('SEND_SPACER');

/** The slice of the agent records the send allowlist reads. */
export type SendRecipientAgents = Pick<AgentStore, 'findByAddress'>;

/** One transfer, as the caller asked for it. */
export interface SendCommand {
  /** The recipient. Must be the caller's own wallet or one of their agents. */
  to: string;
  /** The token's contract, or the zero address for native MON. */
  token: string;
  /** ATOMS, as a decimal string. Never a decimal-shifted figure. */
  amount: string;
}

/**
 * What the owner is being asked to approve, in the terms the screen shows it
 * (the same arrangement as `MandateChangeSummary`).
 *
 * The phone RENDERS this and decides from `payload` — a summary is
 * server-composed prose, so deciding from it would be trusting the party the
 * signature exists to bind (`apps/mobile/src/wallet/send.ts`).
 */
export interface SendSummary {
  from: Address;
  to: Address;
  /** What the allowlist recognised `to` as, so the sheet can name it. */
  recipient: { kind: 'self' } | { kind: 'agent'; agentId: string; agentName: string };
  symbol: string;
  tokenAddress: Address;
  decimals: number;
  /** Atoms, as a decimal string. */
  atoms: string;
  /** The same amount decimal-shifted, for reading. */
  amount: string;
  chainId: number;
  /** Always true today: the whole point is that the user needs no MON. */
  sponsored: boolean;
}

/** A transfer waiting for its owner's signature. */
export interface PreparedSend {
  prepareId: string;
  /** The exact bytes to sign. Rebuild them from the intent before you do. */
  payload: AuthorizationPayload;
  expiresAt: Date;
  summary: SendSummary;
}

/**
 * What committing a prepared send needs that the request does not carry: the
 * wallet it spends from (which is also what the spacing is keyed on) and what
 * the transfer was, for the log and the tracker.
 */
interface SendContext {
  walletId: string;
  summary: SendSummary;
}

/** One phone signature over a prepared send: base64 DER, as Privy carries it. */
export interface SendApproval {
  prepareId: string;
  signature: string;
}

/**
 * A submitted send.
 *
 * `userOpHash` is the hash to follow, and it is a USER OPERATION hash, not a
 * transaction hash (CLAUDE.md gotcha 8): `GET /wallet/operations/:hash` reads
 * the operation's own success flag for it.
 */
export interface SentTransfer {
  userOpHash?: Hash;
  transactionHash?: Hash;
  transactionId?: string;
  status: 'pending' | 'unknown';
  sponsored: boolean;
}

/**
 * ---------------------------------------------------------------------------
 * THE USER'S WALLET (SEN-40 and SEN-42, Phase 3)
 *
 * A Privy server wallet whose owner is the phone's `device` P-256 key. This
 * service creates it, reads it, and COMPOSES the transfers it makes; it can
 * never spend from it, and neither can anything else in this process — the owner
 * key never leaves the device, and Privy enforces that on its side
 * (docs/privy-sponsorship.md, checks 4a-4c). `prepareSend`/`executeSend` are
 * that distinction made operational: the server builds the request, the phone
 * signs it, the server forwards the signature it cannot produce.
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
  /**
   * Transfers prepared for a device owner and not yet committed (SEN-42),
   * through the SAME store the mandate changes use.
   *
   * Process-local state, so it is constructed here rather than injected — the
   * same reasoning as `AgentsService`'s copy. A prepare that outlived the
   * process would be an approval outliving the thing it was given for.
   */
  private readonly prepared = new PreparedApprovals<SendContext>();

  constructor(
    @Inject(USER_WALLETS) private readonly wallets: UserWalletProvider,
    @Inject(USER_WALLET_REGISTRY) private readonly registry: UserWalletRegistry,
    @Inject(TOKEN_BALANCES) private readonly balances: TokenBalanceReader,
    /**
     * The agent records, for one question only: is `to` an agent of the caller's?
     * The SAME instance `agents/` writes (see `agents/store/agent-store.module.ts`).
     */
    @Inject(AGENT_STORE) private readonly agents: SendRecipientAgents,
    /**
     * Where a submitted send goes to be followed. It tracks USER OPERATION
     * hashes and branches on the operation's own success flag, which is exactly
     * what a sponsored send needs (gotcha 8).
     */
    @Inject(OPERATION_TRACKER) private readonly tracker: OperationTracker,
    /**
     * One send at a time per wallet, with the measured floor between them — the
     * same `WriteSpacer` the agent runner spaces its signs with.
     */
    @Inject(SEND_SPACER) private readonly spacer: WriteSpacer,
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
    return this.describe(await this.bound(principal));
  }

  // -------------------------------------------------------------------------
  // SEN-42: SPENDING FROM A WALLET THIS SERVER CANNOT SIGN FOR
  //
  // `prepareSend` composes the exact Privy request and hands back the payload
  // the phone must sign; `executeSend` sends THAT request with the signature
  // attached. Nothing between them touches Privy, and nothing after them
  // recomposes the request: the signature covers its bytes, so composing it
  // twice is how an approved transfer and a sent transfer come to differ.
  //
  // The server can refuse to send a signed transfer, and can propose one the
  // owner then refuses to sign. What it cannot do is move a single atom, which
  // is the property the whole phase exists for.
  // -------------------------------------------------------------------------

  /**
   * The sponsored `eth_sendTransaction` that would move `amount` of `token` to
   * `to`, held for the wallet's owner to approve. Moves nothing.
   *
   * The recipient is checked against an allowlist — the caller's own wallet, or
   * one of the caller's agents — because this route composes bytes somebody is
   * about to sign. The phone checks the same thing independently and would
   * refuse a payload that disagreed; the allowlist is what stops this server
   * from ASKING, which is worth something on its own: a screen that shows a
   * refusal is better than one that shows a prompt.
   *
   * Balances are deliberately NOT checked here. A balance read between the
   * prepare and the signature is a promise about a number that can move, and the
   * chain is the only honest judge of whether a transfer can be paid for; the
   * sheet shows the balance it read so the user is not surprised.
   */
  async prepareSend(principal: Principal, command: SendCommand): Promise<PreparedSend> {
    const binding = await this.bound(principal);
    const token = this.sendableOrRefuse(command.token);
    const atoms = this.atomsOrRefuse(command.amount);
    const to = this.addressOrRefuse(command.to);
    const recipient = await this.recipientOrRefuse(principal, binding, to);

    const summary: SendSummary = {
      from: binding.address,
      to,
      recipient,
      symbol: token.symbol,
      tokenAddress: getAddress(token.address),
      decimals: token.decimals,
      atoms: atoms.toString(),
      amount: formatUnits(atoms, token.decimals),
      chainId: SEND_CHAIN_ID,
      sponsored: true,
    };

    const prepared = await this.wallets.prepareSend({
      walletId: binding.walletId,
      transaction: sponsoredTransferTransaction(token, to, atoms),
    });

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + PREPARED_APPROVAL_TTL_MS);
    const id = randomUUID();
    this.prepared.put({
      id,
      kind: 'wallet_send',
      userId: principal.userId,
      // The subject of a send is the wallet it spends from. One live prepare
      // per wallet: a user approves the transfer in front of them.
      subject: binding.walletId,
      request: prepared.request,
      payload: prepared.payload,
      context: { walletId: binding.walletId, summary },
      createdAt,
      expiresAt,
    });
    return { prepareId: id, payload: prepared.payload, expiresAt, summary };
  }

  /**
   * Sends a prepared transfer with the owner's signature, and starts following
   * the user operation it becomes.
   *
   * The prepare is spent whatever happens next, including a refusal at Privy: a
   * signature that stays committable is a signature waiting to be replayed, and
   * preparing again costs one round trip and one prompt.
   *
   * SPACED, per wallet. The first sponsored send from a wallet also EIP-7702
   * delegates it, which bumps the account's nonce; a send composed before that
   * has landed is refused by the EntryPoint with an "EIP-7702 nonce mismatch"
   * (measured — docs/privy-sponsorship.md, run 3). So the second send WAITS
   * rather than failing: the demo's second action must not depend on a human
   * pausing. `WALLET_SEND_SPACING_MS` is the floor.
   *
   * Nothing here re-resolves the caller's wallet. The prepare carries the wallet
   * it was made for, and that is the one the signature covers — reading the
   * registry again could only introduce a way for the two to differ.
   */
  async executeSend(principal: Principal, approval: SendApproval): Promise<SentTransfer> {
    const prepared = this.takePrepared(principal, approval.prepareId);
    const { walletId, summary } = prepared.context;

    const started = Date.now();
    const outcome = await this.spacer.run(walletId, () =>
      this.commitOrRefuse(prepared.request, approval.signature),
    );
    // The wait the send ACTUALLY took, logged after the fact rather than
    // predicted before it: with another send queued for the same wallet, a
    // figure read before queueing is not the one this caller waited.
    const queuedMs = Date.now() - started;
    if (queuedMs >= this.spacer.spacingMs) {
      this.logger.log(
        `the sponsored send from wallet ${walletId} waited ${queuedMs}ms for its turn; ` +
          'a send composed before the previous one landed is refused by the EntryPoint',
      );
    }

    return this.follow(outcome, summary);
  }

  /** Tracks what came back, and says plainly when there was nothing to track. */
  private follow(outcome: SponsoredSendOutcome, summary: SendSummary): SentTransfer {
    if (outcome.userOpHash) {
      this.tracker.track({
        userOpHash: outcome.userOpHash,
        sender: summary.from,
        sponsored: true,
      });
      this.logger.log(
        `sent ${summary.amount} ${summary.symbol} from ${summary.from} to ${summary.to}: ` +
          `userOp ${outcome.userOpHash} (tx id ${outcome.transactionId ?? 'none'}) — sponsored, ` +
          'so what lands is a USER OPERATION and its own success flag decides',
      );
      return { ...outcome, status: 'pending', sponsored: true };
    }
    // Either Privy stopped sponsoring (a plain transaction hash) or it answered
    // something this code does not know how to follow. Both are `unknown` rather
    // than `pending`: the transfer may well have gone out, and the honest answer
    // is that we cannot say whether it landed.
    this.logger.warn(
      `sponsored send from ${summary.from} answered with no user-operation hash ` +
        `(tx ${outcome.transactionHash ?? 'none'}, id ${outcome.transactionId ?? 'none'}); ` +
        'nothing is being followed for it',
    );
    return { ...outcome, status: 'unknown', sponsored: false };
  }

  private async commitOrRefuse(
    request: Parameters<UserWalletProvider['commitSend']>[0],
    signature: string,
  ): Promise<SponsoredSendOutcome> {
    try {
      return await this.wallets.commitSend(request, { signature });
    } catch (error) {
      if (error instanceof WalletRefusedError) throw error;
      if (error instanceof PrivyError) {
        this.logger.error(`Privy refused a sponsored send: ${error.message}`);
        if (error.isMissingApproval) {
          // The owner did not approve THESE bytes. Not a server error, and not
          // something a retry of the same signature can fix.
          throw new WalletRefusedError(
            'invalid_authorization',
            'The wallet provider did not accept this phone’s signature for this transfer. ' +
              'Prepare it again and approve it on the device that owns the wallet.',
          );
        }
        if (error.code === 'transaction_broadcast_failure') {
          // The one shape seen live is an EIP-7702 nonce mismatch: a send
          // composed before the previous one landed. Named, because "try again"
          // is right for it and misleading for anything else.
          const settling = /nonce/i.test(error.message);
          throw new WalletRefusedError(
            'send_broadcast_failed',
            settling
              ? 'Your previous transfer is still settling, so this one was refused and nothing ' +
                  `moved. Try again in a few seconds. (${error.message})`
              : `The chain refused this transfer, so nothing moved: ${error.message}`,
          );
        }
        throw new WalletRefusedError(
          'user_wallet_provider_failed',
          `The wallet provider refused this transfer: ${error.message}`,
        );
      }
      throw error;
    }
  }

  /** The caller's binding, or `account_not_registered`. */
  private async bound(principal: Principal): Promise<UserWalletBinding> {
    const binding = await this.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No wallet for this user; POST /wallet/register with the device public key first',
      );
    }
    return binding;
  }

  private addressOrRefuse(value: string): Address {
    try {
      return getAddress(value.trim());
    } catch {
      throw new WalletRefusedError('send_recipient_not_allowed', `${value} is not an EVM address`);
    }
  }

  private sendableOrRefuse(value: string): BalanceToken {
    const token = sendableToken(value.trim());
    if (!token) {
      throw new WalletRefusedError(
        'send_token_not_supported',
        `${value} is not a token this wallet can send`,
      );
    }
    return token;
  }

  /** Atoms, strictly: a decimal integer above zero and nothing else. */
  private atomsOrRefuse(value: string): bigint {
    const raw = value.trim();
    if (!/^\d+$/.test(raw)) {
      throw new WalletRefusedError(
        'send_amount_invalid',
        `amount must be a whole number of atoms as a decimal string, got ${JSON.stringify(value)}`,
      );
    }
    const atoms = BigInt(raw);
    if (atoms <= 0n) {
      throw new WalletRefusedError('send_amount_invalid', 'amount must be above zero');
    }
    return atoms;
  }

  /**
   * Who `to` is — or a refusal.
   *
   * Two recipients are allowed and no others: the caller's own wallet, and the
   * wallet of an agent the caller hired. Another user's agent is refused for the
   * same reason a guessed agent id is `agent_not_found`: the answer must not
   * describe somebody else's account.
   */
  private async recipientOrRefuse(
    principal: Principal,
    binding: UserWalletBinding,
    to: Address,
  ): Promise<SendSummary['recipient']> {
    if (isAddressEqual(to, binding.address)) return { kind: 'self' };
    const agent = await this.agents.findByAddress(to);
    if (agent && agent.userId === principal.userId) {
      return { kind: 'agent', agentId: agent.id, agentName: agent.name };
    }
    throw new WalletRefusedError(
      'send_recipient_not_allowed',
      `${to} is neither your wallet nor one of your agents, so this server will not compose a ` +
        'transfer to it',
    );
  }

  /**
   * The prepared send this commit names, spent.
   *
   * Every mismatch — unknown id, expired, already committed, another user's,
   * prepared for a mandate change — is the same refusal, because they are all
   * "there is no such pending transfer", and telling them apart would describe
   * other people's.
   */
  private takePrepared(principal: Principal, prepareId: string) {
    const prepared = this.prepared.take(prepareId, principal.userId, new Date());
    if (!prepared || prepared.kind !== 'wallet_send') {
      throw new WalletRefusedError(
        'send_prepare_not_found',
        `no pending transfer ${prepareId} for this account; prepared transfers are single-use ` +
          `and ` +
          `expire after ${PREPARED_APPROVAL_TTL_MS / 60000} minutes, so prepare it again`,
      );
    }
    return prepared;
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
