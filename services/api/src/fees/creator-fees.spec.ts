import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreatorFeeLedger, creatorShareAtoms, type NewAccrual } from './creator-fees';

const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function fill(over: Partial<NewAccrual> = {}): NewAccrual {
  return {
    creatorUserId: 'creator',
    agentId: 'fork-1',
    sourceAgentId: 'source-1',
    asset: 'USDC',
    decimals: 6,
    // 10 bps of a 35 USDC fill.
    feeAtoms: 35_000n,
    txHash: TX(1),
    ...over,
  };
}

describe('creatorShareAtoms', () => {
  it('is 3/10 of the fee: 3 of Sente’s 10 bps', () => {
    expect(creatorShareAtoms(35_000n)).toBe(10_500n);
    expect(creatorShareAtoms(10n)).toBe(3n);
  });

  it('floors to a whole atom of the asset: the treasury never owes more than it took', () => {
    expect(creatorShareAtoms(1n)).toBe(0n);
    expect(creatorShareAtoms(3n)).toBe(0n);
    expect(creatorShareAtoms(4n)).toBe(1n);
    expect(creatorShareAtoms(33_333n)).toBe(9_999n);
  });

  it('owes nothing on nothing', () => {
    expect(creatorShareAtoms(0n)).toBe(0n);
    expect(creatorShareAtoms(-5n)).toBe(0n);
  });
});

describe('CreatorFeeLedger', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-creator-fees-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accrues each fill once, keyed by agent and transaction', () => {
    const ledger = new CreatorFeeLedger();
    expect(ledger.accrue(fill())!.amountAtoms).toBe(10_500n);
    expect(ledger.accrue(fill({ txHash: TX(1).toUpperCase().replace('0X', '0x') }))).toBeNull();
    expect(ledger.accrue(fill({ txHash: TX(2) }))!.amountAtoms).toBe(10_500n);
    // A dust fee that floors to zero is not worth a record.
    expect(ledger.accrue(fill({ txHash: TX(3), feeAtoms: 3n }))).toBeNull();
    expect(ledger.totals('creator')).toEqual([
      { asset: 'USDC', decimals: 6, accruedAtoms: 21_000n, paidAtoms: 0n, owedAtoms: 21_000n },
    ]);
  });

  it('owed is accrued less paid, per creator and per asset', () => {
    const ledger = new CreatorFeeLedger();
    ledger.accrue(fill());
    ledger.accrue(fill({ creatorUserId: 'other', txHash: TX(2) }));
    ledger.payout({
      creatorUserId: 'creator',
      asset: 'USDC',
      decimals: 6,
      amountAtoms: 10_000n,
      txHash: TX(100),
    });
    expect(ledger.totals('creator')[0]).toMatchObject({ paidAtoms: 10_000n, owedAtoms: 500n });
    expect(ledger.totals('other')[0]).toMatchObject({ paidAtoms: 0n, owedAtoms: 10_500n });
    expect(ledger.totals('nobody')).toEqual([]);
    expect(ledger.recent('creator', 10).map((r) => r.kind)).toEqual(
      expect.arrayContaining(['accrued', 'payout']),
    );
    expect(ledger.creators().sort()).toEqual(['creator', 'other']);
  });

  it('refuses a payout above what is owed, a repeated tx, or a malformed hash', () => {
    const ledger = new CreatorFeeLedger();
    ledger.accrue(fill());
    const payout = {
      creatorUserId: 'creator',
      asset: 'USDC',
      decimals: 6,
      amountAtoms: 10_501n,
      txHash: TX(100),
    };
    expect(() => ledger.payout(payout)).toThrow(/owed 10500/);
    ledger.payout({ ...payout, amountAtoms: 500n });
    expect(() => ledger.payout({ ...payout, amountAtoms: 1n })).toThrow(/already recorded/);
    expect(() => ledger.payout({ ...payout, amountAtoms: 1n, txHash: '0x12' })).toThrow(
      /not a transaction hash/,
    );
    expect(() => ledger.payout({ ...payout, amountAtoms: 0n, txHash: TX(101) })).toThrow(
      /positive/,
    );
  });

  it('survives a restart: atoms and dates come back as bigint and Date', () => {
    const path = join(dir, 'creator-fees.json');
    const first = new CreatorFeeLedger(path);
    first.accrue(fill({ at: new Date('2026-10-09T12:00:00Z') }));
    const second = new CreatorFeeLedger(path);
    expect(second.size).toBe(1);
    const [record] = second.recent('creator', 1);
    expect(record!.amountAtoms).toBe(10_500n);
    expect(record!.at).toEqual(new Date('2026-10-09T12:00:00Z'));
    // The dedup key survives too.
    expect(second.accrue(fill())).toBeNull();
  });
});
