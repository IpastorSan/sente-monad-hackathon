/**
 * `GET /portfolio/history` and `GET /agents/:id/history` (SEN-152).
 * `apps/mobile/src/portfolio/history.ts` copies these types — change one and
 * change the other.
 */
import { IsIn, IsOptional } from 'class-validator';

import type { Decimal } from '../../venues/dto/markets.dto';

export const HISTORY_RANGES = ['1d', '1w', '1m', 'all'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export class HistoryQueryDto {
  /** Defaults to `1d`, the hero's first pill. */
  @IsOptional()
  @IsIn(HISTORY_RANGES)
  range?: HistoryRange;
}

export interface ValuePointDto {
  at: number;
  /** ≈ $, exact decimal. */
  usd: Decimal;
  /** Leaves out a section, agent or price that did not answer at the time. */
  partial?: true;
}

export interface ValueHistoryDto {
  range: HistoryRange;
  /** Unix ms of this answer. */
  asOf: number;
  /** Start of the window: `asOf` minus the range, or the first point for `all`. */
  from: number;
  /** Oldest first, downsampled to at most ~120. Empty until the first snapshot. */
  points: ValuePointDto[];
  /** Whether any returned point is partial. */
  partial: boolean;
  /** How often a point is taken, in ms: the chart's resolution. */
  everyMs: number;
  note: string;
}
