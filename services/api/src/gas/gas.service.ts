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
import { GasDripRefusedError } from './gas.errors';
import type { GasDripPrincipal } from './auth/gas-drip-auth';
import { DRIP_LEDGER, utcDay, type DripLedger } from './ledger/drip-ledger';
import { IP_RATE_LIMITER, type IpRateLimiter } from './rate-limit/ip-rate-limiter';
import { SENDER_POOL, type DripSendResult } from './sender/drip-sender';
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
  dryRun: boolean;
}

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
    let sent: DripSendResult;
    let gasLimit: bigint;
    try {
      gasLimit = await this.gasLimitFor(address);
      sent = await this.senders.send(address, this.config.amountWei, gasLimit);
    } catch (error) {
      await this.ledger.release(claim.reservation.id);
      if (error instanceof GasDripRefusedError) {
        throw error;
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
      dryRun: this.config.dryRun,
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
