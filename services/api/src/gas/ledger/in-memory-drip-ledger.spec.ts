import { parseEther, type Address, type Hash } from 'viem';

import { utcDay } from './drip-ledger';
import { InMemoryDripLedger } from './in-memory-drip-ledger';

const ADDRESS_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address;
const ADDRESS_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as Address;
const TX = `0x${'ab'.repeat(32)}` as Hash;

const AMOUNT = parseEther('0.1');
const CAP = parseEther('0.25');
const NOW = new Date('2026-09-08T10:00:00.000Z');

function ledgerWithClaim(): { ledger: InMemoryDripLedger; claim: typeof base } {
  const ledger = new InMemoryDripLedger();
  return { ledger, claim: base };
}

const base = {
  userId: 'user-1',
  address: ADDRESS_A,
  amountWei: AMOUNT,
  dailyCapWei: CAP,
  now: NOW,
};

describe('InMemoryDripLedger', () => {
  it('accepts a first claim and reports the running daily total', async () => {
    const { ledger } = ledgerWithClaim();

    const result = await ledger.claim(base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dailyTotalWei).toBe(AMOUNT);
    expect(result.reservation.status).toBe('reserved');
    expect(result.reservation.day).toBe('2026-09-08');
    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(AMOUNT);
  });

  it('refuses a second claim for the same user, even with a new address', async () => {
    const { ledger } = ledgerWithClaim();
    await ledger.claim(base);

    const result = await ledger.claim({ ...base, address: ADDRESS_B });

    expect(result).toEqual({ ok: false, reason: 'user_already_dripped' });
  });

  it('refuses a second claim for the same address, even from a new user', async () => {
    const { ledger } = ledgerWithClaim();
    await ledger.claim(base);

    const result = await ledger.claim({ ...base, userId: 'user-2' });

    expect(result).toEqual({ ok: false, reason: 'address_already_dripped' });
  });

  it('matches addresses case-insensitively', async () => {
    const { ledger } = ledgerWithClaim();
    await ledger.claim(base);

    expect(await ledger.findByAddress(ADDRESS_A.toLowerCase() as Address)).toBeDefined();
    expect(await ledger.findByAddress(ADDRESS_A)).toBeDefined();
  });

  it('refuses once the day would cross the cap, and lets the next day through', async () => {
    const ledger = new InMemoryDripLedger();
    for (const i of [1, 2]) {
      const result = await ledger.claim({
        ...base,
        userId: `user-${i}`,
        address: `0x${String(i).repeat(40)}` as Address,
      });
      expect(result.ok).toBe(true);
    }

    const third = await ledger.claim({
      ...base,
      userId: 'user-3',
      address: ADDRESS_B,
    });
    expect(third).toEqual({ ok: false, reason: 'daily_cap_reached' });

    const tomorrow = await ledger.claim({
      ...base,
      userId: 'user-3',
      address: ADDRESS_B,
      now: new Date('2026-09-09T00:00:01.000Z'),
    });
    expect(tomorrow.ok).toBe(true);
  });

  it('gives budget and dedupe keys back when a reservation is released', async () => {
    const { ledger } = ledgerWithClaim();
    const claimed = await ledger.claim(base);
    if (!claimed.ok) throw new Error('expected claim to succeed');

    await ledger.release(claimed.reservation.id);

    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(0n);
    expect(await ledger.findByUserId('user-1')).toBeUndefined();
    expect(await ledger.findByAddress(ADDRESS_A)).toBeUndefined();
    expect((await ledger.claim(base)).ok).toBe(true);
  });

  it('will not release a confirmed drip — the MON is already gone', async () => {
    const { ledger } = ledgerWithClaim();
    const claimed = await ledger.claim(base);
    if (!claimed.ok) throw new Error('expected claim to succeed');

    await ledger.confirm(claimed.reservation.id, TX);
    await ledger.release(claimed.reservation.id);

    const record = await ledger.findByUserId('user-1');
    expect(record?.status).toBe('confirmed');
    expect(record?.txHash).toBe(TX);
    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(AMOUNT);
  });

  it('lets only one of many concurrent claims for the same user through', async () => {
    const ledger = new InMemoryDripLedger();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.claim({
          ...base,
          dailyCapWei: parseEther('100'),
          address: `0x${String(i + 1).repeat(40)}` as Address,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(AMOUNT);
  });
});

describe('InMemoryDripLedger.claimAgent', () => {
  const agentBase = {
    userId: 'user-1',
    agentId: 'agent-1',
    address: ADDRESS_A,
    amountWei: AMOUNT,
    dailyCapWei: parseEther('100'),
    maxPerUserPerDay: 2,
    now: NOW,
  };
  const address = (n: number) => `0x${String(n).repeat(40)}` as Address;

  it('allows one claim per agent, even at a new address', async () => {
    const ledger = new InMemoryDripLedger();
    const first = await ledger.claimAgent(agentBase);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.reservation.agentId).toBe('agent-1');

    expect(await ledger.claimAgent({ ...agentBase, address: ADDRESS_B })).toEqual({
      ok: false,
      reason: 'agent_already_dripped',
    });
    expect((await ledger.findByAgentId('agent-1'))?.address).toBe(ADDRESS_A.toLowerCase());
  });

  it('allows one claim per address, shared with user drips', async () => {
    const ledger = new InMemoryDripLedger();
    await ledger.claim(base);

    expect(await ledger.claimAgent(agentBase)).toEqual({
      ok: false,
      reason: 'address_already_dripped',
    });

    const other = new InMemoryDripLedger();
    await other.claimAgent(agentBase);
    expect(await other.claim({ ...base, userId: 'user-2' })).toEqual({
      ok: false,
      reason: 'address_already_dripped',
    });
  });

  it('is not the user’s own drip, and the user’s own drip does not block it', async () => {
    const ledger = new InMemoryDripLedger();
    expect((await ledger.claimAgent(agentBase)).ok).toBe(true);
    expect(await ledger.findByUserId('user-1')).toBeUndefined();
    expect((await ledger.claim({ ...base, address: ADDRESS_B })).ok).toBe(true);
    expect(
      (await ledger.claimAgent({ ...agentBase, agentId: 'agent-2', address: address(3) })).ok,
    ).toBe(true);
  });

  it('caps agents per user per UTC day, per user, and resets the next day', async () => {
    const ledger = new InMemoryDripLedger();
    for (const n of [1, 2]) {
      const result = await ledger.claimAgent({
        ...agentBase,
        agentId: `agent-${n}`,
        address: address(n),
      });
      expect(result.ok).toBe(true);
    }

    const third = { ...agentBase, agentId: 'agent-3', address: address(3) };
    expect(await ledger.claimAgent(third)).toEqual({
      ok: false,
      reason: 'agent_daily_limit_reached',
    });
    expect(
      (
        await ledger.claimAgent({
          ...third,
          userId: 'user-2',
          agentId: 'agent-4',
          address: address(4),
        })
      ).ok,
    ).toBe(true);
    expect(
      (await ledger.claimAgent({ ...third, now: new Date('2026-09-09T00:00:01.000Z') })).ok,
    ).toBe(true);
  });

  it('applies the global daily cap, counting user drips too', async () => {
    const ledger = new InMemoryDripLedger();
    await ledger.claim({ ...base, dailyCapWei: CAP }); // 0.1 of 0.25

    expect(
      (await ledger.claimAgent({ ...agentBase, address: address(1), dailyCapWei: CAP })).ok,
    ).toBe(true); // 0.2
    expect(
      await ledger.claimAgent({
        ...agentBase,
        agentId: 'agent-2',
        address: address(2),
        dailyCapWei: CAP,
      }),
    ).toEqual({ ok: false, reason: 'daily_cap_reached' });
  });

  it('gives the agent id, the address, the per-user slot and the budget back on release', async () => {
    const ledger = new InMemoryDripLedger();
    const limited = { ...agentBase, maxPerUserPerDay: 1 };
    const claimed = await ledger.claimAgent(limited);
    if (!claimed.ok) throw new Error('expected claim to succeed');

    await ledger.release(claimed.reservation.id);

    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(0n);
    expect(await ledger.findByAgentId('agent-1')).toBeUndefined();
    expect(await ledger.findByAddress(ADDRESS_A)).toBeUndefined();
    expect((await ledger.claimAgent(limited)).ok).toBe(true);
  });

  it('lets only one of many concurrent claims for the same agent through', async () => {
    const ledger = new InMemoryDripLedger();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.claimAgent({ ...agentBase, maxPerUserPerDay: 100, address: address(i + 1) }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await ledger.dailyTotalWei(utcDay(NOW))).toBe(AMOUNT);
  });
});
