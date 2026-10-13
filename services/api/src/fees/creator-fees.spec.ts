import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openedDbs } from '../state/db/testing/opened-dbs';
import {
  creatorShareAtoms,
  FileCreatorFeeLedger,
  type CreatorFeeLedger,
  type NewAccrual,
} from './creator-fees';
import { SqliteCreatorFeeLedger } from './sqlite-creator-fees';

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

let dir: string;
const dbs = openedDbs();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sente-creator-fees-'));
});

afterEach(() => {
  dbs.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** A SQLite ledger on `<dir>/sente.db`; calling it again is a restart. */
const sqliteLedger = () => new SqliteCreatorFeeLedger(dbs.reopen(dir));

/** Every implementation `STATE_DIR` and `STORE_BACKEND` can pick, through one table (SEN-205). */
describe.each([
  ['in memory', (): CreatorFeeLedger => new FileCreatorFeeLedger()],
  ['FileCreatorFeeLedger', (): CreatorFeeLedger => new FileCreatorFeeLedger(join(dir, 'c.json'))],
  ['SqliteCreatorFeeLedger', (): CreatorFeeLedger => sqliteLedger()],
])('%s', (_name, create) => {

  it('accrues each fill once, keyed by agent and transaction', () => {
    const ledger = create();
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
    const ledger = create();
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

  it('keeps each asset apart: a buy’s base fee and a sell’s USDC fee (SEN-195)', () => {
    const ledger = create();
    // 13 cbBTC atoms, the live Set C buy's fee (tx 0xca084e71…): 3 atoms owed.
    ledger.accrue(fill({ asset: 'cbBTC', decimals: 8, feeAtoms: 13n, txHash: TX(1) }));
    ledger.accrue(fill({ txHash: TX(2) }));
    // The same fill reporting a second asset is a second entry, not a replay.
    ledger.accrue(fill({ asset: 'cbBTC', decimals: 8, feeAtoms: 10n, txHash: TX(2) }));
    expect(ledger.totals('creator')).toEqual([
      { asset: 'cbBTC', decimals: 8, accruedAtoms: 6n, paidAtoms: 0n, owedAtoms: 6n },
      { asset: 'USDC', decimals: 6, accruedAtoms: 10_500n, paidAtoms: 0n, owedAtoms: 10_500n },
    ]);
    const cbBtcPayout = {
      creatorUserId: 'creator',
      asset: 'cbBTC',
      decimals: 8,
      amountAtoms: 7n,
      txHash: TX(100),
    };
    // USDC owed does not cover a cbBTC payout.
    expect(() => ledger.payout(cbBtcPayout)).toThrow(/owed 6 cbBTC/);
    ledger.payout({ ...cbBtcPayout, amountAtoms: 6n });
    expect(ledger.totals('creator')).toEqual([
      { asset: 'cbBTC', decimals: 8, accruedAtoms: 6n, paidAtoms: 6n, owedAtoms: 0n },
      { asset: 'USDC', decimals: 6, accruedAtoms: 10_500n, paidAtoms: 0n, owedAtoms: 10_500n },
    ]);
  });

  it('refuses a payout above what is owed, a repeated tx, or a malformed hash', () => {
    const ledger = create();
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

  it('answers recent records newest first, a tie in recorded order', () => {
    const ledger = create();
    const at = (s: string) => new Date(`2026-10-0${s}T12:00:00Z`);
    ledger.accrue(fill({ txHash: TX(1), at: at('1') }));
    ledger.accrue(fill({ txHash: TX(2), at: at('3') }));
    ledger.accrue(fill({ txHash: TX(3), at: at('2') }));
    ledger.accrue(fill({ txHash: TX(4), at: at('3') }));
    expect(ledger.recent('creator', 3).map((r) => r.txHash)).toEqual([TX(2), TX(4), TX(3)]);
  });
});

describe.each([
  ['FileCreatorFeeLedger', () => new FileCreatorFeeLedger(join(dir, 'creator-fees.json'))],
  ['SqliteCreatorFeeLedger', () => sqliteLedger()],
])('%s across a restart', (_name, open) => {
  it('keeps every record: atoms and dates come back as bigint and Date', () => {
    const first = open();
    first.accrue(fill({ at: new Date('2026-10-09T12:00:00Z') }));
    const second = open();
    expect(second.size).toBe(1);
    const [record] = second.recent('creator', 1);
    expect(record!.amountAtoms).toBe(10_500n);
    expect(record!.at).toEqual(new Date('2026-10-09T12:00:00Z'));
    // The dedup key survives too.
    expect(second.accrue(fill())).toBeNull();
  });
});
