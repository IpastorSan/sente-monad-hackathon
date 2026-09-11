import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { getAddress, type Address, type Hash, type Hex } from 'viem';

import type { BalanceReader, CodeReader } from './chain/monad-chain.providers';
import type { GasDripAgentConfig, GasDripConfig } from './gas.config';
import { GasDripRefusedError } from './gas.errors';
import { GasDripService } from './gas.service';
import { InMemoryDripLedger } from './ledger/in-memory-drip-ledger';
import { utcDay, type DripLedger } from './ledger/drip-ledger';
import type { IpRateLimiter } from './rate-limit/ip-rate-limiter';
import type { DripSender } from './sender/drip-sender';
import {
  DripUnconfirmedError,
  ReserveAwareDispatcher,
  ReserveBalanceBusyError,
  type DripDispatcher,
} from './sender/reserve-aware-dispatcher';
import { SenderPool } from './sender/sender-pool';

const ONE_TENTH_MON = 100_000_000_000_000_000n;
const AGENT_AMOUNT = 150_000_000_000_000_000n;
const USER = { userId: 'user-1' };
const ADDRESS = '0x1111111111111111111111111111111111111111';
const SENDER = '0x9999999999999999999999999999999999999999' as Address;
const IP = '203.0.113.7';

const AGENT_DEFAULTS: GasDripAgentConfig = {
  amountWei: AGENT_AMOUNT,
  maxPerUserPerDay: 3,
  senderSpacingMs: 5_000,
  receiptTimeoutMs: 15_000,
};

const config = (over: Partial<GasDripConfig> = {}): GasDripConfig => ({
  senderKeys: [],
  amountWei: ONE_TENTH_MON,
  dailyCapWei: ONE_TENTH_MON * 10n,
  gasLimit: 21_000n,
  gasLimitContract: 46_000n,
  rpcUrl: undefined,
  rateLimit: { max: 100, windowMs: 60_000 },
  agent: AGENT_DEFAULTS,
  dryRun: false,
  ...over,
});

/** Always allows, unless told otherwise. */
const rateLimiter = (allow = true): IpRateLimiter =>
  ({ hit: () => allow }) as unknown as IpRateLimiter;

const balances = (wei: bigint): BalanceReader => ({
  getBalance: async () => wei,
});

/** A fake `eth_getCode`: `undefined`/`0x` is no code, anything else is a contract. */
const codeReader = (code: Hex | undefined | Error): CodeReader => ({
  getCode: async () => {
    if (code instanceof Error) {
      throw code;
    }
    return code;
  },
});

/** Runtime code of a deployed Kernel account — the content is irrelevant, only its presence. */
const KERNEL_CODE = '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a9' as Hex;

/** Only its size matters here: every send goes through the dispatcher. */
const senderPool = (empty = false): SenderPool =>
  ({ size: empty ? 0 : 3, addresses: () => [SENDER] }) as unknown as SenderPool;

const DRIP_TX = `0x${'a9'.repeat(32)}` as Hash;
const UNCONFIRMED_TX = `0x${'be'.repeat(32)}` as Hash;

type DispatchBehaviour = 'ok' | 'busy' | 'unconfirmed' | 'throw';

/**
 * A fake of the reserve-aware dispatcher, shared by user and agent drips; its
 * own behaviour is specced in its file, and wired for real further down.
 */
function dripDispatcher(behaviour: DispatchBehaviour) {
  const sends: { to: Address; value: bigint; gasLimit: bigint }[] = [];
  const dispatcher: DripDispatcher = {
    send: async (to, value, gasLimit) => {
      sends.push({ to, value, gasLimit });
      switch (behaviour) {
        case 'busy':
          throw new ReserveBalanceBusyError([`0x${'de'.repeat(32)}` as Hash]);
        case 'unconfirmed':
          throw new DripUnconfirmedError(
            { hash: UNCONFIRMED_TX, nonce: 1, sender: SENDER },
            new Error('timed out'),
          );
        case 'throw':
          throw new Error('rpc exploded');
        case 'ok':
          return { hash: DRIP_TX, nonce: 9, sender: SENDER, reverted: [] };
      }
    },
  };
  return { dispatcher, sends };
}

function build(
  over: {
    cfg?: Partial<GasDripConfig>;
    agent?: Partial<GasDripAgentConfig>;
    ledger?: DripLedger;
    balanceWei?: bigint;
    balances?: BalanceReader;
    allowIp?: boolean;
    noSenders?: boolean;
    code?: Hex | undefined | Error;
    dispatch?: DispatchBehaviour;
  } = {},
) {
  const ledger = over.ledger ?? new InMemoryDripLedger();
  const { dispatcher, sends } = dripDispatcher(over.dispatch ?? 'ok');
  const service = new GasDripService(
    config({ ...over.cfg, agent: { ...AGENT_DEFAULTS, ...over.agent } }),
    ledger,
    senderPool(over.noSenders),
    over.balances ?? balances(over.balanceWei ?? 0n),
    rateLimiter(over.allowIp ?? true),
    codeReader(over.code),
    dispatcher,
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

    expect(receipt.txHash).toBe(DRIP_TX);
    expect(receipt.confirmed).toBe(true);
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
    const { service } = build({ noSenders: true });
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
    const { service, ledger } = build({ dispatch: 'throw' });

    await expect(service.drip(USER, { address: ADDRESS, ip: IP })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Reservation released: no budget consumed, and the user may retry.
    const day = new Date().toISOString().slice(0, 10);
    expect(await ledger.dailyTotalWei(day)).toBe(0n);
    expect(await ledger.findByUserId(USER.userId)).toBeUndefined();
  });

  describe('gas limit per recipient', () => {
    it.each([
      ['no code (viem returns undefined)', undefined],
      ['empty code (0x)', '0x' as Hex],
    ])('sends an EOA / counterfactual account the 21k limit: %s', async (_label, code) => {
      const { service, sends } = build({ code });

      await service.drip(USER, { address: ADDRESS, ip: IP });

      expect(sends).toEqual([{ to: ADDRESS, value: ONE_TENTH_MON, gasLimit: 21_000n }]);
    });

    it('sends an address with code (a deployed Kernel account) the contract limit', async () => {
      const { service, sends } = build({ code: KERNEL_CODE });

      await service.drip(USER, { address: ADDRESS, ip: IP });

      // 21k reverts there: the account's receive() measured 40,995 gas.
      expect(sends).toEqual([{ to: ADDRESS, value: ONE_TENTH_MON, gasLimit: 46_000n }]);
    });

    it('uses the configured limits, not hard-coded ones', async () => {
      const cfg = { gasLimit: 22_000n, gasLimitContract: 48_000n };
      const eoa = build({ cfg, code: undefined });
      const contract = build({ cfg, code: KERNEL_CODE });

      await eoa.service.drip(USER, { address: ADDRESS, ip: IP });
      await contract.service.drip(USER, { address: ADDRESS, ip: IP });

      expect(eoa.sends[0]?.gasLimit).toBe(22_000n);
      expect(contract.sends[0]?.gasLimit).toBe(48_000n);
    });

    it('does not read code for a refused drip', async () => {
      const getCode = jest.fn(async (): Promise<Hex | undefined> => undefined);
      const service = new GasDripService(
        config(),
        new InMemoryDripLedger(),
        senderPool(),
        balances(1n),
        rateLimiter(),
        { getCode },
        dripDispatcher('ok').dispatcher,
      );

      expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe(
        'address_already_funded',
      );
      expect(getCode).not.toHaveBeenCalled();
    });

    it('gives the budget back when the code read fails, and does not send', async () => {
      const { service, ledger, sends } = build({ code: new Error('getCode timed out') });

      await expect(service.drip(USER, { address: ADDRESS, ip: IP })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(sends).toHaveLength(0);
      const day = new Date().toISOString().slice(0, 10);
      expect(await ledger.dailyTotalWei(day)).toBe(0n);
      expect(await ledger.findByUserId(USER.userId)).toBeUndefined();
    });
  });

  describe('through the reserve-aware dispatcher (SEN-16)', () => {
    it('refuses with reserve_balance_busy and gives the budget back when every key is busy', async () => {
      const { service, ledger } = build({ dispatch: 'busy' });

      expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe(
        'reserve_balance_busy',
      );

      // Nothing moved, so the user may retry.
      const day = new Date().toISOString().slice(0, 10);
      expect(await ledger.dailyTotalWei(day)).toBe(0n);
      expect(await ledger.findByUserId(USER.userId)).toBeUndefined();
      expect(await ledger.findByAddress(ADDRESS)).toBeUndefined();
    });

    it('keeps an unconfirmed drip spent, reports it unconfirmed, and never sends it twice', async () => {
      const { service, ledger, sends } = build({ dispatch: 'unconfirmed' });

      const receipt = await service.drip(USER, { address: ADDRESS, ip: IP });

      expect(receipt).toMatchObject({ txHash: UNCONFIRMED_TX, confirmed: false });
      const day = new Date().toISOString().slice(0, 10);
      expect(await ledger.dailyTotalWei(day)).toBe(ONE_TENTH_MON);
      expect(await refusal(service.drip(USER, { address: ADDRESS, ip: IP }))).toBe(
        'user_already_dripped',
      );
      expect(sends).toHaveLength(1);
    });

    it('still reports dry run, with the dispatcher doing the send', async () => {
      const { service, sends } = build({ cfg: { dryRun: true } });

      const receipt = await service.drip(USER, { address: ADDRESS, ip: IP });

      expect(receipt).toMatchObject({ dryRun: true, confirmed: true, txHash: DRIP_TX });
      expect(sends).toHaveLength(1);
    });
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

describe('GasDripService.dripToAgent', () => {
  const agent = (n: number, userId = 'user-1') => ({
    userId,
    agentId: `agent-${n}`,
    address: `0x${(0xa0 + n).toString(16).padStart(40, '0')}`,
  });
  const today = () => utcDay(new Date());

  it('funds an agent once, with the agent amount, keyed on the agent id and the address', async () => {
    const { service, sends } = build();

    const first = await service.dripToAgent(agent(1));

    expect(first).toMatchObject({
      funded: true,
      receipt: { amountWei: AGENT_AMOUNT, txHash: DRIP_TX, revertedTxHashes: [] },
    });
    expect(sends).toEqual([
      { to: getAddress(agent(1).address), value: AGENT_AMOUNT, gasLimit: 21_000n },
    ]);
    // The same agent again, even at another address.
    expect(await service.dripToAgent({ ...agent(1), address: agent(9).address })).toMatchObject({
      funded: false,
      reason: 'agent_already_dripped',
    });
    // Another agent at an address already funded.
    expect(await service.dripToAgent({ ...agent(2), address: agent(1).address })).toMatchObject({
      funded: false,
      reason: 'address_already_dripped',
    });
    expect(sends).toHaveLength(1);
  });

  it('lets one user fund several agents, up to the per-user daily cap', async () => {
    const { service, sends } = build({ agent: { maxPerUserPerDay: 2 } });

    expect((await service.dripToAgent(agent(1))).funded).toBe(true);
    expect((await service.dripToAgent(agent(2))).funded).toBe(true);
    expect(await service.dripToAgent(agent(3))).toMatchObject({
      funded: false,
      reason: 'agent_daily_limit_reached',
    });
    // The cap is per user.
    expect((await service.dripToAgent(agent(4, 'user-2'))).funded).toBe(true);
    expect(sends).toHaveLength(3);
  });

  it('neither uses up nor is blocked by the user’s own drip', async () => {
    const userFirst = build();
    await userFirst.service.drip(USER, { address: ADDRESS, ip: IP });
    expect((await userFirst.service.dripToAgent(agent(1))).funded).toBe(true);

    const agentFirst = build();
    expect((await agentFirst.service.dripToAgent(agent(1))).funded).toBe(true);
    const receipt = await agentFirst.service.drip(USER, { address: ADDRESS, ip: IP });
    expect(receipt.amountWei).toBe(ONE_TENTH_MON);
  });

  it('shares the global daily cap with user drips', async () => {
    const { service, sends } = build({
      cfg: { dailyCapWei: ONE_TENTH_MON + AGENT_AMOUNT },
    });
    await service.drip(USER, { address: ADDRESS, ip: IP });
    expect((await service.dripToAgent(agent(1))).funded).toBe(true);

    expect(await service.dripToAgent(agent(2))).toMatchObject({
      funded: false,
      reason: 'daily_cap_reached',
    });
    // The user drip and the first agent drip; the refused one never sent.
    expect(sends.map((s) => s.value)).toEqual([ONE_TENTH_MON, AGENT_AMOUNT]);
  });

  it('refuses an address already holding the drip amount, and tops up one holding less', async () => {
    const full = build({ balanceWei: AGENT_AMOUNT });
    expect(await full.service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'address_already_funded',
    });
    expect(full.sends).toHaveLength(0);

    const low = build({ balanceWei: AGENT_AMOUNT - 1n });
    expect((await low.service.dripToAgent(agent(1))).funded).toBe(true);
  });

  it('refuses when no faucet keys are configured', async () => {
    const { service, sends } = build({ noSenders: true });
    expect(await service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'faucet_unconfigured',
    });
    expect(sends).toHaveLength(0);
  });

  it('sizes the gas limit from the code at the agent address', async () => {
    // An EIP-7702-delegated EOA has code; its receive() runs on the send.
    const { service, sends } = build({ code: KERNEL_CODE });
    await service.dripToAgent(agent(1));
    expect(sends[0]?.gasLimit).toBe(46_000n);
  });

  it('gives the budget back when every key is inside its reserve window', async () => {
    const { service, ledger } = build({ dispatch: 'busy' });

    expect(await service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'reserve_balance_busy',
    });

    // Nothing moved, so the agent can still be funded later.
    expect(await ledger.dailyTotalWei(today())).toBe(0n);
    expect(await ledger.findByAgentId('agent-1')).toBeUndefined();
  });

  it('keeps an unconfirmed drip spent and never sends it twice', async () => {
    const { service, ledger, sends } = build({ dispatch: 'unconfirmed' });

    expect(await service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'drip_unconfirmed',
      txHash: UNCONFIRMED_TX,
    });
    // It may still land: the budget stays spent and a retry is refused.
    expect(await ledger.dailyTotalWei(today())).toBe(AGENT_AMOUNT);
    expect(await service.dripToAgent(agent(1))).toMatchObject({ reason: 'agent_already_dripped' });
    expect(sends).toHaveLength(1);
  });

  it('reports a failed send as drip_failed and gives the budget back', async () => {
    const { service, ledger } = build({ dispatch: 'throw' });

    expect(await service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'drip_failed',
    });
    expect(await ledger.dailyTotalWei(today())).toBe(0n);
  });

  it('never throws, even when a read fails before the claim', async () => {
    const { service, ledger } = build({
      balances: { getBalance: () => Promise.reject(new Error('rpc down')) },
    });

    expect(await service.dripToAgent(agent(1))).toMatchObject({
      funded: false,
      reason: 'drip_failed',
    });
    expect(await ledger.findByAgentId('agent-1')).toBeUndefined();
  });

  it('lets only one of several concurrent drips for the same agent through', async () => {
    const { service, sends } = build();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => service.dripToAgent(agent(1))),
    );

    expect(outcomes.filter((o) => o.funded)).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });
});

/**
 * SEN-16: the user drip and the agent drip share one real `ReserveAwareDispatcher`
 * over a real `SenderPool`. Only the keys, the chain and the clock are fake;
 * `sleep` moves the clock forward instantly, so spacing costs no real time.
 */
describe('GasDripService spacing across user and agent drips', () => {
  const SPACING_MS = 5_000;
  const RECEIPT_MS = 1_000;
  const AGENT = {
    userId: 'user-9',
    agentId: 'agent-1',
    address: '0x00000000000000000000000000000000000000a1',
  };

  function wired(keys: number) {
    let t = 1_000_000;
    const now = () => t;
    const sends: { from: Address; value: bigint; at: number }[] = [];
    const receiptAt: number[] = [];
    const members: DripSender[] = Array.from({ length: keys }, (_, i) => {
      const address = `0x${(0xf0 + i).toString(16).padStart(40, '0')}` as Address;
      let nonce = 0;
      return {
        address,
        send: (_to, value) => {
          sends.push({ from: address, value, at: t });
          const n = nonce++;
          const hash = `0x${(0xf0 + i).toString(16)}${n.toString(16).padStart(62, '0')}` as Hash;
          return Promise.resolve({ hash, nonce: n, sender: address });
        },
      };
    });
    const pool = new SenderPool(members, now);
    const dispatcher = new ReserveAwareDispatcher(
      pool,
      { simulateTransfer: () => Promise.resolve() },
      {
        waitForReceipt: () => {
          t += RECEIPT_MS;
          receiptAt.push(t);
          return Promise.resolve('success');
        },
      },
      {
        spacingMs: SPACING_MS,
        receiptTimeoutMs: 15_000,
        now,
        sleep: (ms) => {
          t += ms;
          return Promise.resolve();
        },
      },
    );
    const service = new GasDripService(
      config(),
      new InMemoryDripLedger(),
      pool,
      balances(0n),
      rateLimiter(),
      codeReader(undefined),
      dispatcher,
    );
    return { service, sends, receiptAt };
  }

  it.each([
    ['a user drip, then an agent drip', ['user', 'agent'] as const],
    ['an agent drip, then a user drip', ['agent', 'user'] as const],
  ])('spaces %s from the same key', async (_label, order) => {
    const { service, sends, receiptAt } = wired(1);
    const run = (kind: 'user' | 'agent') =>
      kind === 'user'
        ? service.drip(USER, { address: ADDRESS, ip: IP })
        : service.dripToAgent(AGENT);

    await run(order[0]);
    await run(order[1]);

    expect(sends).toHaveLength(2);
    expect(sends[1]!.from).toBe(sends[0]!.from);
    expect(sends[1]!.at).toBeGreaterThanOrEqual(receiptAt[0]! + SPACING_MS);
  });

  it('spaces them even when they arrive together', async () => {
    const { service, sends, receiptAt } = wired(1);

    const [user, agent] = await Promise.all([
      service.drip(USER, { address: ADDRESS, ip: IP }),
      service.dripToAgent(AGENT),
    ]);

    expect(user.confirmed).toBe(true);
    expect(agent.funded).toBe(true);
    expect(sends[1]!.at).toBeGreaterThanOrEqual(receiptAt[0]! + SPACING_MS);
  });

  it('takes the fast path: a user drip after an agent drip uses a free key at once', async () => {
    const { service, sends, receiptAt } = wired(2);

    await service.dripToAgent(AGENT);
    await service.drip(USER, { address: ADDRESS, ip: IP });

    expect(sends.map((s) => s.value)).toEqual([AGENT_AMOUNT, ONE_TENTH_MON]);
    expect(sends[1]!.from).not.toBe(sends[0]!.from);
    // No spacing wait: the user drip went out as soon as the agent drip's receipt was in.
    expect(sends[1]!.at).toBe(receiptAt[0]);
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
