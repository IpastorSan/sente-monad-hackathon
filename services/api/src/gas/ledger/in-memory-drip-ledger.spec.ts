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
