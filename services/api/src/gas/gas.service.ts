import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { formatEther, getAddress, isAddress, type Address, type Hash } from 'viem';

import {
  BALANCE_READER,
  CODE_READER,
  type BalanceReader,
  type CodeReader,
} from './chain/monad-chain.providers';
import { GAS_DRIP_CONFIG, type GasDripConfig } from './gas.config';
import { GasDripRefusedError, type AgentDripRefusalReason } from './gas.errors';
import type { GasDripPrincipal } from './auth/gas-drip-auth';
import {
  DRIP_LEDGER,
  utcDay,
  type AgentLedgerRefusalReason,
  type DripLedger,
} from './ledger/drip-ledger';
import { IP_RATE_LIMITER, type IpRateLimiter } from './rate-limit/ip-rate-limiter';
import { SENDER_POOL } from './sender/drip-sender';
import {
  DRIP_DISPATCHER,
  DripUnconfirmedError,
  ReserveBalanceBusyError,
  type ConfirmedSend,
  type DripDispatcher,
} from './sender/reserve-aware-dispatcher';
import type { SenderPool } from './sender/sender-pool';

export interface DripCommand {
  /** Destination. Comes from the request body — only the ADDRESS may. */
  address: string;
  /** Client IP for the coarse rate limit. */
  ip: string;
}

export interface DripReceipt {
  address: Address;
  amountWei: bigint;
  txHash: Hash;
  sender: Address;
  nonce: number;
  /** Faucet outflow so far today, including this drip. */
  dailyTotalWei: bigint;
  dailyCapWei: bigint;
  /**
   * True once the receipt is in. False when it did not arrive in time: the
   * transaction may still land, so it is never re-sent and the drip counts as
   * spent — the caller can follow `txHash` itself.
   */
  confirmed: boolean;
  dryRun: boolean;
}

/** Server-initiated: every field comes from the stored agent, never from a request body. */
export interface AgentDripCommand {
  /** The hiring user; counts toward their per-day agent cap. */
  userId: string;
  agentId: string;
  /** The agent's EOA. */
  address: string;
}

export interface AgentDripReceipt {
  address: Address;
  amountWei: bigint;
  txHash: Hash;
  sender: Address;
  nonce: number;
  /** Earlier attempts that reverted on the reserve balance (gas spent, no MON moved). */
  revertedTxHashes: Hash[];
  dailyTotalWei: bigint;
  dryRun: boolean;
}

/** Never an exception: a hire must not fail because its agent could not be funded. */
export type AgentDripOutcome =
  | { funded: true; receipt: AgentDripReceipt }
  | { funded: false; reason: AgentDripRefusalReason; message: string; txHash?: Hash };

export interface FaucetStatus {
  configured: boolean;
  senders: number;
  amountMon: string;
  dailyCapMon: string;
  dailyTotalMon: string;
  dryRun: boolean;
}

/**
 * The MON gas drip: a new Mera passkey account holds zero MON and Mera ships no
 * paymaster, so without a top-up a user cannot send their first transaction.
 * MOV-253 (gas-sponsored Kernel smart account) is the real answer; this is the
 * safety net that has no external dependencies.
 *
 * Identity is a parameter, never read from the body — see `auth/gas-drip-auth.ts`.
 */
@Injectable()
export class GasDripService {
  private readonly logger = new Logger(GasDripService.name);

  constructor(
    @Inject(GAS_DRIP_CONFIG) private readonly config: GasDripConfig,
    @Inject(DRIP_LEDGER) private readonly ledger: DripLedger,
    @Inject(SENDER_POOL) private readonly senders: SenderPool,
    @Inject(BALANCE_READER) private readonly balances: BalanceReader,
    @Inject(IP_RATE_LIMITER) private readonly rateLimiter: IpRateLimiter,
    @Inject(CODE_READER) private readonly code: CodeReader,
    @Inject(DRIP_DISPATCHER) private readonly dispatcher: DripDispatcher,
  ) {}

  async status(now: Date = new Date()): Promise<FaucetStatus> {
    return {
      configured: this.senders.size > 0,
      senders: this.senders.size,
      amountMon: formatEther(this.config.amountWei),
      dailyCapMon: formatEther(this.config.dailyCapWei),
      dailyTotalMon: formatEther(await this.ledger.dailyTotalWei(utcDay(now))),
      dryRun: this.config.dryRun,
    };
  }

  /**
   * Guards run cheapest-first so an obviously-refused call never costs an RPC
   * round trip, and so the caller gets the most specific reason: a user who has
   * already dripped must hear `user_already_dripped`, not the
   * `address_already_funded` they would trip over a step later.
   */
  async drip(principal: GasDripPrincipal, command: DripCommand): Promise<DripReceipt> {
    const now = new Date();

    // 1. Per-IP rate limit. First because it is the only free check.
    if (!this.rateLimiter.hit(command.ip, now)) {
      throw new GasDripRefusedError(
        'rate_limited',
        'Too many drip attempts from this address; try again later',
      );
    }

    // 2. Nothing to send from.
    if (this.senders.size === 0) {
      throw new GasDripRefusedError(
        'faucet_unconfigured',
        'No faucet senders configured; set GAS_DRIP_PRIVATE_KEYS',
      );
    }

    // The DTO validates this too; belt and braces for non-HTTP callers. A
    // malformed address is a caller bug, not a faucet refusal, so it is a 400.
    if (!isAddress(command.address)) {
      throw new BadRequestException('address must be a 20-byte hex address');
    }
    const address = getAddress(command.address);
    const ledgerAddress = address.toLowerCase() as Address;

    // 3. One drip per user, ever.
    if (await this.ledger.findByUserId(principal.userId)) {
      throw new GasDripRefusedError('user_already_dripped', 'This account has already been funded');
    }

    // 4. One drip per address, ever — tracked separately, because a user can
    //    come back with a freshly generated address.
    if (await this.ledger.findByAddress(ledgerAddress)) {
      throw new GasDripRefusedError(
        'address_already_dripped',
        'This address has already been funded',
      );
    }

    // 5. Already has MON? Then it does not need the safety net.
    const balance = await this.balances.getBalance({ address });
    if (balance > 0n) {
      throw new GasDripRefusedError(
        'address_already_funded',
        `Address already holds ${formatEther(balance)} MON`,
      );
    }

    // 6. Atomic claim: re-checks 3 and 4 and applies the global daily cap BEFORE
    //    any send. Steps 3-4 above are the fast path for a good error message;
    //    this is the authoritative, race-free one.
    const claim = await this.ledger.claim({
      userId: principal.userId,
      address: ledgerAddress,
      amountWei: this.config.amountWei,
      dailyCapWei: this.config.dailyCapWei,
      now,
    });
    if (!claim.ok) {
      throw new GasDripRefusedError(claim.reason, refusalMessage(claim.reason));
    }

    // 7. Size the gas limit for this recipient, then send. Budget is already
    //    reserved, so a failure of either must give it back. The code read sits
    //    right before the send to keep the "deployed in between" window small.
    //    The send goes through the same reserve-aware dispatcher as the agent
    //    drip (SEN-16), so the two are spaced per key against each other. A free
    //    key past its spacing sends at once; the cost over a bare send is the
    //    advisory `eth_call` and waiting for the receipt (about a second).
    let sent: ConfirmedSend;
    let gasLimit: bigint;
    try {
      gasLimit = await this.gasLimitFor(address);
      sent = await this.dispatcher.send(address, this.config.amountWei, gasLimit);
    } catch (error) {
      if (error instanceof DripUnconfirmedError) {
        // Broadcast but not confirmed in time. It may still land, so the
        // budget and both dedupe keys stay spent and it is never re-sent —
        // the same outcome as before SEN-16, when no drip waited for a receipt.
        await this.ledger.confirm(claim.reservation.id, error.sent.hash);
        this.logger.warn(`drip unconfirmed user=${principal.userId}: ${error.message}`);
        return {
          address,
          amountWei: this.config.amountWei,
          txHash: error.sent.hash,
          sender: error.sent.sender,
          nonce: error.sent.nonce,
          dailyTotalWei: claim.dailyTotalWei,
          dailyCapWei: this.config.dailyCapWei,
          confirmed: false,
          dryRun: this.config.dryRun,
        };
      }
      // Nothing moved: give the budget back so the user can retry.
      await this.ledger.release(claim.reservation.id);
      if (error instanceof GasDripRefusedError) {
        throw error;
      }
      if (error instanceof ReserveBalanceBusyError) {
        this.logger.warn(`drip refused user=${principal.userId}: ${error.message}`);
        throw new GasDripRefusedError(
          'reserve_balance_busy',
          'Every faucet key is inside its reserve-balance window; try again shortly',
        );
      }
      this.logger.error(
        `drip send failed address=${address} user=${principal.userId}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException('Faucet transfer failed; please retry');
    }

    await this.ledger.confirm(claim.reservation.id, sent.hash);

    this.logger.log(
      `drip ok address=${address} amount=${formatEther(this.config.amountWei)} MON ` +
        `tx=${sent.hash} sender=${sent.sender} nonce=${sent.nonce} gas=${gasLimit} ` +
        `reverted=${sent.reverted.length} ` +
        `dailyTotal=${formatEther(claim.dailyTotalWei)}/${formatEther(this.config.dailyCapWei)} MON ` +
        `user=${principal.userId}${this.config.dryRun ? ' (DRY RUN)' : ''}`,
    );

    return {
      address,
      amountWei: this.config.amountWei,
      txHash: sent.hash,
      sender: sent.sender,
      nonce: sent.nonce,
      dailyTotalWei: claim.dailyTotalWei,
      dailyCapWei: this.config.dailyCapWei,
      confirmed: true,
      dryRun: this.config.dryRun,
    };
  }

  /**
   * The agent drip (SEN-14): MON for a freshly hired agent's own EOA, which
   * pays gas on every Kuru transaction and on its Perpl onboarding.
   *
   * It cannot reuse `drip`: that one is keyed on the user, so a user who took
   * their own drip could never fund an agent, and funding an agent would use
   * up the user's own. Instead:
   *   - one drip per agent id, ever, and one per address, ever (the address
   *     table is shared with user drips);
   *   - at most `agent.maxPerUserPerDay` agents per hiring user per UTC day;
   *   - the same global daily cap as `drip`;
   *   - refused when the address already holds at least the drip amount.
   * No per-IP limit: the caller is the server, after an authenticated hire.
   *
   * Sends go through `ReserveAwareDispatcher`, which spaces sends per faucet
   * key and waits for the receipt — see that file for the reserve balance.
   *
   * Never throws. Every refusal and failure comes back as `funded: false`
   * with a stable reason, because the hire it follows must still succeed.
   */
  async dripToAgent(command: AgentDripCommand): Promise<AgentDripOutcome> {
    try {
      return await this.fundAgent(command, new Date());
    } catch (error) {
      this.logger.error(
        `agent drip failed agent=${command.agentId} user=${command.userId}: ${describeError(error)}`,
      );
      return agentRefusal('drip_failed', 'The gas drip failed; fund the agent manually');
    }
  }

  private async fundAgent(command: AgentDripCommand, now: Date): Promise<AgentDripOutcome> {
    if (this.senders.size === 0) {
      return agentRefusal(
        'faucet_unconfigured',
        'No faucet senders configured; set GAS_DRIP_PRIVATE_KEYS',
      );
    }
    if (!isAddress(command.address)) {
      // The address comes from the wallet provider, so this is a bug upstream.
      throw new Error(`agent ${command.agentId} has no valid address`);
    }
    const address = getAddress(command.address);
    const ledgerAddress = address.toLowerCase() as Address;
    const amountWei = this.config.agent.amountWei;

    // Cheap checks first, for the most specific reason; `claimAgent` below is
    // the authoritative, race-free one.
    if (await this.ledger.findByAgentId(command.agentId)) {
      return agentRefusal('agent_already_dripped', agentRefusalMessage('agent_already_dripped'));
    }
    if (await this.ledger.findByAddress(ledgerAddress)) {
      return agentRefusal(
        'address_already_dripped',
        agentRefusalMessage('address_already_dripped'),
      );
    }
    const balance = await this.balances.getBalance({ address });
    if (balance >= amountWei) {
      return agentRefusal(
        'address_already_funded',
        `Address already holds ${formatEther(balance)} MON`,
      );
    }

    const claim = await this.ledger.claimAgent({
      userId: command.userId,
      agentId: command.agentId,
      address: ledgerAddress,
      amountWei,
      dailyCapWei: this.config.dailyCapWei,
      maxPerUserPerDay: this.config.agent.maxPerUserPerDay,
      now,
    });
    if (!claim.ok) {
      return agentRefusal(claim.reason, agentRefusalMessage(claim.reason));
    }

    let sent: ConfirmedSend;
    let gasLimit: bigint;
    try {
      gasLimit = await this.gasLimitFor(address);
      sent = await this.dispatcher.send(address, amountWei, gasLimit);
    } catch (error) {
      if (error instanceof DripUnconfirmedError) {
        // It may still land, so the budget and the dedupe keys stay spent and
        // it is never re-sent. Worst case the agent is unfunded and says so.
        await this.ledger.confirm(claim.reservation.id, error.sent.hash);
        this.logger.warn(`agent drip unconfirmed agent=${command.agentId}: ${error.message}`);
        return {
          ...agentRefusal('drip_unconfirmed', `Drip ${error.sent.hash} was not confirmed in time`),
          txHash: error.sent.hash,
        };
      }
      // Nothing moved: give the budget back so the agent can be funded later.
      await this.ledger.release(claim.reservation.id);
      if (error instanceof ReserveBalanceBusyError) {
        this.logger.warn(`agent drip refused agent=${command.agentId}: ${error.message}`);
        return agentRefusal(
          'reserve_balance_busy',
          'Every faucet key is inside its reserve-balance window; try again shortly',
        );
      }
      if (error instanceof GasDripRefusedError && error.reason === 'faucet_unconfigured') {
        return agentRefusal('faucet_unconfigured', error.message);
      }
      this.logger.error(
        `agent drip send failed address=${address} agent=${command.agentId}: ${describeError(error)}`,
      );
      return agentRefusal('drip_failed', 'Faucet transfer failed');
    }

    await this.ledger.confirm(claim.reservation.id, sent.hash);

    this.logger.log(
      `agent drip ok agent=${command.agentId} address=${address} ` +
        `amount=${formatEther(amountWei)} MON tx=${sent.hash} sender=${sent.sender} ` +
        `nonce=${sent.nonce} gas=${gasLimit} reverted=${sent.reverted.length} ` +
        `dailyTotal=${formatEther(claim.dailyTotalWei)}/${formatEther(this.config.dailyCapWei)} MON ` +
        `user=${command.userId}${this.config.dryRun ? ' (DRY RUN)' : ''}`,
    );

    return {
      funded: true,
      receipt: {
        address,
        amountWei,
        txHash: sent.hash,
        sender: sent.sender,
        nonce: sent.nonce,
        revertedTxHashes: sent.reverted,
        dailyTotalWei: claim.dailyTotalWei,
        dryRun: this.config.dryRun,
      },
    };
  }

  /**
   * A MON send into an address with code runs that code: a deployed Kernel
   * account's `receive()` measured 40,995 gas, so the 21k EOA limit reverts
   * and burns the gas. No code (an EOA, or a Kernel account that is still
   * counterfactual) keeps the 21k limit — Monad charges the LIMIT, so the
   * higher one is paid only where it is needed (CLAUDE.md gotcha 4).
   */
  private async gasLimitFor(address: Address): Promise<bigint> {
    const code = await this.code.getCode({ address });
    return code && code !== '0x' ? this.config.gasLimitContract : this.config.gasLimit;
  }
}

function refusalMessage(
  reason: 'user_already_dripped' | 'address_already_dripped' | 'daily_cap_reached',
): string {
  switch (reason) {
    case 'user_already_dripped':
      return 'This account has already been funded';
    case 'address_already_dripped':
      return 'This address has already been funded';
    case 'daily_cap_reached':
      return 'The faucet has reached its daily limit; try again tomorrow';
  }
}

function agentRefusal(
  reason: AgentDripRefusalReason,
  message: string,
): { funded: false; reason: AgentDripRefusalReason; message: string } {
  return { funded: false, reason, message };
}

function agentRefusalMessage(reason: AgentLedgerRefusalReason): string {
  switch (reason) {
    case 'agent_already_dripped':
      return 'This agent has already been funded';
    case 'address_already_dripped':
      return 'This address has already been funded';
    case 'agent_daily_limit_reached':
      return 'You have funded the most agents allowed today; fund this one manually';
    case 'daily_cap_reached':
      return 'The faucet has reached its daily limit; fund this agent manually';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
