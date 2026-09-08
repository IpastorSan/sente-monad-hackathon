import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import type { BalanceReader } from './chain/monad-chain.providers';
import type { GasDripConfig } from './gas.config';
import { GasDripRefusedError } from './gas.errors';
import { GasDripService } from './gas.service';
import { InMemoryDripLedger } from './ledger/in-memory-drip-ledger';
import type { DripLedger } from './ledger/drip-ledger';
import type { IpRateLimiter } from './rate-limit/ip-rate-limiter';
import type { DripSendResult } from './sender/drip-sender';
import type { SenderPool } from './sender/sender-pool';

const ONE_TENTH_MON = 100_000_000_000_000_000n;
const USER = { userId: 'user-1' };
const ADDRESS = '0x1111111111111111111111111111111111111111';
const SENDER = '0x9999999999999999999999999999999999999999' as Address;
const IP = '203.0.113.7';

const config = (over: Partial<GasDripConfig> = {}): GasDripConfig => ({
  senderKeys: [],
  amountWei: ONE_TENTH_MON,
  dailyCapWei: ONE_TENTH_MON * 10n,
  gasLimit: 21_000n,
  rpcUrl: undefined,
  rateLimit: { max: 100, windowMs: 60_000 },
  dryRun: false,
  ...over,
});

/** Always allows, unless told otherwise. */
const rateLimiter = (allow = true): IpRateLimiter =>
  ({ hit: () => allow }) as unknown as IpRateLimiter;

const balances = (wei: bigint): BalanceReader => ({
  getBalance: async () => wei,
});

function senderPool(behaviour: 'ok' | 'throw' | 'empty' = 'ok') {
  const sends: { to: Address; value: bigint }[] = [];
  const pool = {
    size: behaviour === 'empty' ? 0 : 3,
    addresses: () => [SENDER],
    send: async (to: Address, value: bigint): Promise<DripSendResult> => {
      if (behaviour === 'throw') {
        throw new Error('rpc exploded');
      }
      sends.push({ to, value });
      return { hash: '0xfeed' as Hash, nonce: 4, sender: SENDER };
    },
  } as unknown as SenderPool;
  return { pool, sends };
}

function build(
  over: {
    cfg?: Partial<GasDripConfig>;
    ledger?: DripLedger;
    balanceWei?: bigint;
    allowIp?: boolean;
    senders?: 'ok' | 'throw' | 'empty';
  } = {},
) {
  const ledger = over.ledger ?? new InMemoryDripLedger();
  const { pool, sends } = senderPool(over.senders ?? 'ok');
  const service = new GasDripService(
    config(over.cfg),
    ledger,
    pool,
    balances(over.balanceWei ?? 0n),
    rateLimiter(over.allowIp ?? true),
  );
  return { service, ledger, sends };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('expected a refusal, got success');
  } catch (error) {
    if (error instanceof GasDripRefusedError) {
      return error.reason;
    }
    throw error;
  }
}

describe('GasDripService.drip', () => {
  it('funds a fresh account and reports the running daily total', async () => {
    const { service, sends } = build();

    const receipt = await service.drip(USER, { address: ADDRESS, ip: IP });

    expect(receipt.txHash).toBe('0xfeed');
    expect(receipt.amountWei).toBe(ONE_TENTH_MON);
    expect(receipt.dailyTotalWei).toBe(ONE_TENTH_MON);
    expect(sends).toHaveLength(1);
    // Checksummed on the way out, lowercased only inside the ledger.
    expect(receipt.address).toBe('0x1111111111111111111111111111111111111111');
  });

  it('refuses a rate-limited caller before touching anything else', async () => {
    const { service, sends } = build({ allowIp: false });
    expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe('rate_limited');
    expect(sends).toHaveLength(0);
  });

  it('refuses when no faucet keys are configured', async () => {
    const { service } = build({ senders: 'empty' });
    expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe(
      'faucet_unconfigured',
    );
  });

  it('rejects a malformed address as a caller bug, not a faucet refusal', async () => {
    const { service } = build();
    await expect(service.drip(USER, { address: 'not-an-address', ip: IP })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a second drip for the same user, even with a new address', async () => {
    const { service } = build();
    await service.drip(USER, { address: ADDRESS, ip: IP });

    const reason = await refusal(
      service.drip(USER, { address: '0x2222222222222222222222222222222222222222', ip: IP }),
    );
    expect(reason).toBe('user_already_dripped');
  });

  it('refuses a second drip for the same address, even from a new user', async () => {
    const { service } = build();
    await service.drip(USER, { address: ADDRESS, ip: IP });

    const reason = await refusal(service.drip({ userId: 'user-2' }, { address: ADDRESS, ip: IP }));
    expect(reason).toBe('address_already_dripped');
  });

  it('refuses an address that already holds MON — it does not need the safety net', async () => {
    const { service, sends } = build({ balanceWei: 1n });
    expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe(
      'address_already_funded',
    );
    expect(sends).toHaveLength(0);
  });

  it('refuses once the daily cap would be crossed, and does not send', async () => {
    const { service, sends } = build({ cfg: { dailyCapWei: ONE_TENTH_MON } });
    await service.drip(USER, { address: ADDRESS, ip: IP });

    const reason = await refusal(
      service.drip(
        { userId: 'user-2' },
        { address: '0x3333333333333333333333333333333333333333', ip: IP },
      ),
    );
    expect(reason).toBe('daily_cap_reached');
    expect(sends).toHaveLength(1);
  });

  it('gives the budget back when the send fails, so a broken RPC cannot drain the cap', async () => {
    const { service, ledger } = build({ senders: 'throw' });

    await expect(service.drip(USER, { address: ADDRESS, ip: IP })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Reservation released: no budget consumed, and the user may retry.
    const day = new Date().toISOString().slice(0, 10);
    expect(await ledger.dailyTotalWei(day)).toBe(0n);
    expect(await ledger.findByUserId(USER.userId)).toBeUndefined();
  });

  it('lets only one of several concurrent drips for the same user through', async () => {
    const { service, sends } = build();

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        service.drip(USER, {
          address: `0x${(i + 10).toString(16).padStart(40, '0')}`,
          ip: IP,
        }),
      ),
    );

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });
});

describe('GasDripService.status', () => {
  it('reports configuration and today’s outflow in MON', async () => {
    const { service } = build();
    await service.drip(USER, { address: ADDRESS, ip: IP });

    const status = await service.status();
    expect(status.configured).toBe(true);
    expect(status.amountMon).toBe('0.1');
    expect(status.dailyTotalMon).toBe('0.1');
    expect(status.dryRun).toBe(false);
  });
});
