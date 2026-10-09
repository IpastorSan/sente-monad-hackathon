/**
 * What Sente owes the creators of forked agents (SEN-184).
 *
 * Every Kuru order an agent places pays Sente's builder fee (10 bps) to the
 * treasury. When that agent was FORKED from another user's published agent
 * (`AgentRecord.forkedFrom`), 3 of those 10 bps belong to the source agent's
 * owner — the creator whose strategy is running. Nothing moves on chain for
 * it: the fee lands in the treasury whole, this ledger records the creator's
 * share of each fill, and a periodic, manual payout from the treasury settles
 * it (`scripts/creator-payout.ts` records that transfer).
 *
 * One file, `creator-fees.json` under `STATE_DIR` (CLAUDE.md gotcha 14), two
 * kinds of record:
 *
 * - `accrued`: one per fee-paying fill of a forked agent, keyed by the fill's
 *   transaction and agent so a replayed event cannot count twice. The share is
 *   floored to whole atoms of the fee's asset: the treasury never owes more
 *   than it took.
 * - `payout`: one per treasury transfer to a creator, with its tx hash.
 *
 * Owed = accrued - paid, per asset. A forker who forks their own agent is not
 * their own creator: no share accrues.
 *
 * Erasable syntax and `.ts` specifiers (CLAUDE.md gotcha 10): the payout
 * script loads this file under node's type stripping.
 */
import { randomUUID } from 'node:crypto';

import { JsonRecordFile } from '../state/json-file.ts';

export const CREATOR_FEES = Symbol('CREATOR_FEES');

/** `<STATE_DIR>/creator-fees.json`. */
export const CREATOR_FEES_FILE = 'creator-fees';

/** The creator's share of Sente's fee: 3 of the 10 bps. */
export const CREATOR_SHARE = { numerator: 3n, denominator: 10n } as const;

export interface CreatorFeeAccrual {
  readonly kind: 'accrued';
  readonly id: string;
  /** The source agent's owner: who is owed. */
  readonly creatorUserId: string;
  /** The forked agent whose fill paid the fee. */
  readonly agentId: string;
  readonly sourceAgentId: string;
  /** The fee's asset, e.g. `USDC`. */
  readonly asset: string;
  readonly decimals: number;
  /** The whole Sente fee of the fill, in atoms. */
  readonly feeAtoms: bigint;
  /** The creator's share of it, in atoms (floored). */
  readonly amountAtoms: bigint;
  /** The fill's transaction. */
  readonly txHash: string;
  readonly at: Date;
}

export interface CreatorFeePayout {
  readonly kind: 'payout';
  readonly id: string;
  readonly creatorUserId: string;
  readonly asset: string;
  readonly decimals: number;
  readonly amountAtoms: bigint;
  /** The treasury's transfer to the creator. */
  readonly txHash: string;
  readonly at: Date;
  readonly note?: string;
}

export type CreatorFeeRecord = CreatorFeeAccrual | CreatorFeePayout;

/** Per asset, in atoms. */
export interface CreatorFeeTotals {
  readonly asset: string;
  readonly decimals: number;
  readonly accruedAtoms: bigint;
  readonly paidAtoms: bigint;
  readonly owedAtoms: bigint;
}

/** The creator's share of `feeAtoms`, floored to a whole atom. */
export function creatorShareAtoms(feeAtoms: bigint): bigint {
  if (feeAtoms <= 0n) return 0n;
  return (feeAtoms * CREATOR_SHARE.numerator) / CREATOR_SHARE.denominator;
}

export type NewAccrual = Omit<CreatorFeeAccrual, 'kind' | 'id' | 'amountAtoms' | 'at'> & {
  readonly at?: Date;
};

export type NewPayout = Omit<CreatorFeePayout, 'kind' | 'id' | 'at'> & { readonly at?: Date };

export class CreatorFeeLedger {
  readonly #file: JsonRecordFile<CreatorFeeRecord> | undefined;
  readonly #records: CreatorFeeRecord[];

  /** With `path` (`STATE_DIR` set) every record is written through; in memory otherwise. */
  constructor(path?: string) {
    this.#file = path ? new JsonRecordFile<CreatorFeeRecord>(path) : undefined;
    this.#records = this.#file?.load() ?? [];
  }

  get path(): string | undefined {
    return this.#file?.path;
  }

  get size(): number {
    return this.#records.length;
  }

  /**
   * Records the creator's share of one fill's fee. `null` when there is
   * nothing to record: a share that floors to zero, or a fill already
   * recorded for this agent and transaction.
   */
  accrue(input: NewAccrual): CreatorFeeAccrual | null {
    const amountAtoms = creatorShareAtoms(input.feeAtoms);
    if (amountAtoms === 0n) return null;
    const seen = this.#records.some(
      (r) =>
        r.kind === 'accrued' &&
        r.agentId === input.agentId &&
        r.txHash.toLowerCase() === input.txHash.toLowerCase(),
    );
    if (seen) return null;
    const record: CreatorFeeAccrual = {
      ...input,
      kind: 'accrued',
      id: randomUUID(),
      amountAtoms,
      at: input.at ?? new Date(),
    };
    this.#append(record);
    return record;
  }

  /**
   * Records a treasury transfer to a creator. Refuses one larger than what is
   * owed in that asset, or a tx hash already recorded: a payout is entered by
   * hand, and both are typos worth stopping.
   */
  payout(input: NewPayout): CreatorFeePayout {
    if (input.amountAtoms <= 0n) throw new Error('a payout must be positive');
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      throw new Error(`"${input.txHash}" is not a transaction hash`);
    }
    if (this.#records.some((r) => r.txHash.toLowerCase() === input.txHash.toLowerCase())) {
      throw new Error(`${input.txHash} is already recorded`);
    }
    const owed =
      this.totals(input.creatorUserId).find((t) => t.asset === input.asset)?.owedAtoms ?? 0n;
    if (input.amountAtoms > owed) {
      throw new Error(
        `${input.creatorUserId} is owed ${owed} ${input.asset} atoms, less than ${input.amountAtoms}`,
      );
    }
    const record: CreatorFeePayout = {
      ...input,
      kind: 'payout',
      id: randomUUID(),
      at: input.at ?? new Date(),
    };
    this.#append(record);
    return record;
  }

  /** Accrued, paid and owed per asset, for one creator. */
  totals(creatorUserId: string): CreatorFeeTotals[] {
    const byAsset = new Map<string, { decimals: number; accrued: bigint; paid: bigint }>();
    for (const r of this.#records) {
      if (r.creatorUserId !== creatorUserId) continue;
      const sum = byAsset.get(r.asset) ?? { decimals: r.decimals, accrued: 0n, paid: 0n };
      if (r.kind === 'accrued') sum.accrued += r.amountAtoms;
      else sum.paid += r.amountAtoms;
      byAsset.set(r.asset, sum);
    }
    return [...byAsset.entries()].map(([asset, sum]) => ({
      asset,
      decimals: sum.decimals,
      accruedAtoms: sum.accrued,
      paidAtoms: sum.paid,
      owedAtoms: sum.accrued - sum.paid,
    }));
  }

  /** One creator's records, newest first. */
  recent(creatorUserId: string, limit: number): CreatorFeeRecord[] {
    return this.#records
      .filter((r) => r.creatorUserId === creatorUserId)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }

  /** Every creator something is owed to, for the payout script. */
  creators(): string[] {
    return [...new Set(this.#records.map((r) => r.creatorUserId))];
  }

  #append(record: CreatorFeeRecord): void {
    this.#records.push(record);
    try {
      this.#file?.save(this.#records);
    } catch (error) {
      // Unpersisted must not look persisted.
      this.#records.pop();
      throw error;
    }
  }
}
