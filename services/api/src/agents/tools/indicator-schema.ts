/**
 * The indicator request shapes `get_indicators` (SEN-180) takes, shared with
 * the watchers (SEN-182) so a watcher names an indicator exactly as the tool
 * does and is computed by the same math.
 */
import * as z from 'zod/v4';

import type { IndicatorSpec } from './indicators';
import { invalidInput } from './refusals';

export const KLINE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

export const MAX_INDICATOR_PERIOD = 200;

const indicatorPeriod = (fallback: number, min = 2) =>
  z.number().int().min(min).max(MAX_INDICATOR_PERIOD).default(fallback).describe('Candles.');

export const indicatorSpec = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sma'), period: indicatorPeriod(20) }),
  z.strictObject({ type: z.literal('ema'), period: indicatorPeriod(20) }),
  z.strictObject({ type: z.literal('wma'), period: indicatorPeriod(20) }),
  z.strictObject({
    type: z.literal('macd'),
    fast: indicatorPeriod(12),
    slow: indicatorPeriod(26),
    signal: indicatorPeriod(9),
  }),
  z.strictObject({ type: z.literal('rsi'), period: indicatorPeriod(14) }),
  z.strictObject({
    type: z.literal('stochastic'),
    k: indicatorPeriod(14),
    d: indicatorPeriod(3, 1),
    smooth: indicatorPeriod(3, 1).describe('%K smoothing in candles; 1 for fast %K.'),
  }),
  z.strictObject({ type: z.literal('atr'), period: indicatorPeriod(14) }),
  z.strictObject({
    type: z.literal('bollinger'),
    period: indicatorPeriod(20),
    stddev: z.number().min(0.5).max(5).default(2).describe('Band width in σ.'),
  }),
  z.strictObject({ type: z.literal('vwap') }),
  z.strictObject({ type: z.literal('obv') }),
  z.strictObject({ type: z.literal('adx'), period: indicatorPeriod(14) }),
  z.strictObject({ type: z.literal('force_index'), period: indicatorPeriod(13) }),
  z.strictObject({ type: z.literal('elder_ray'), period: indicatorPeriod(13) }),
]);

/** The one rule the schema cannot state per field. */
export function checkSpec(spec: IndicatorSpec): IndicatorSpec {
  if (spec.type === 'macd' && spec.fast >= spec.slow) {
    throw invalidInput(`macd needs fast < slow; got fast ${spec.fast}, slow ${spec.slow}`);
  }
  return spec;
}
