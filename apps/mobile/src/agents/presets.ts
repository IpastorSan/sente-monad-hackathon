/**
 * Mandate presets for the hire flow's "Draw the lines" step (SEN-59).
 *
 * A preset is a FILLED FORM, never a mandate. Picking one writes values into
 * the same `MandateForm` the fields edit, and the mandate still comes out of
 * `buildMandate` — through {@link mandateToSend}, the one path the screen uses.
 * So a preset can't produce anything a person couldn't have typed, the API's
 * validator still sees exactly what it saw before presets existed, and
 * `approval.ts` still checks the rules against the mandate the phone built.
 * `presets.test.ts` pins both halves: every preset builds a mandate the API
 * accepts, and for the same inputs the bytes sent are the bytes sent before.
 *
 * Standard is today's default form, unchanged. Cautious and Wide move the
 * three limits people actually reach for — order size, deposit cap, expiry —
 * down and up; Wide also opens Perpl at a modest 2×.
 *
 * Plain node, no React Native, so the spec runs without a device.
 */
import type { Address } from 'viem';

import {
  buildMandate,
  defaultMandateForm,
  KURU_MARKETS,
  type BuildResult,
  type MandateForm,
} from './mandate.ts';

const DAY_SECONDS = 86_400;

export type PresetId = 'cautious' | 'standard' | 'wide';
/** `custom` is what the chip shows once any field is edited after a preset. */
export type PresetChoice = PresetId | 'custom';

export const PRESET_CHOICES: readonly { value: PresetChoice; label: string }[] = [
  { value: 'cautious', label: 'Cautious' },
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'custom', label: 'Custom' },
];

/** What a preset sets: the form, and the expiry chip (counted from submitting). */
export type PresetValues = { form: MandateForm; expiryDays: number };

function marketAddresses(symbols: readonly string[]): Address[] {
  return KURU_MARKETS.filter((market) => symbols.includes(market.symbol)).map(
    (market) => market.address,
  );
}

/**
 * The form a preset fills. `returnTo` is the caller's own wallet, carried
 * through exactly as `defaultMandateForm` carries it: the way out is never
 * something a preset chooses (SEN-17).
 */
export function presetValues(id: PresetId, now: number, returnTo?: Address): PresetValues {
  const standard = defaultMandateForm(now, returnTo);
  switch (id) {
    case 'standard':
      return { form: standard, expiryDays: 7 };
    case 'cautious':
      return {
        form: {
          ...standard,
          depositCaps: { USDC: '25' },
          maxOrderNotional: '10',
          expiresAt: now + DAY_SECONDS,
        },
        expiryDays: 1,
      };
    case 'wide':
      return {
        form: {
          ...standard,
          perpl: true,
          kuruMarkets: marketAddresses(['MON-USDC', 'WETH-USDC']),
          depositCaps: { USDC: '500' },
          perplCollateral: '250',
          perplMarkets: 'BTC-PERP, ETH-PERP',
          maxLeverage: '2',
          maxOrderNotional: '250',
          expiresAt: now + 30 * DAY_SECONDS,
        },
        expiryDays: 30,
      };
  }
}

/**
 * When the mandate ends. An expiry chip counts from `now` — the moment of
 * submitting, not the moment the chip was pressed — and `null` keeps
 * `form.expiresAt` as is (an amend that leaves the current expiry alone).
 * The "Ends" line, the read-back and the mandate sent all ask this.
 */
export function resolveExpiry(
  form: Pick<MandateForm, 'expiresAt'>,
  expiryDays: number | null,
  now: number,
): number {
  return expiryDays === null ? form.expiresAt : now + expiryDays * DAY_SECONDS;
}

/** The mandate the flow sends, and the only way it makes one. */
export function mandateToSend(
  form: MandateForm,
  expiryDays: number | null,
  now: number,
): BuildResult {
  return buildMandate({ ...form, expiresAt: resolveExpiry(form, expiryDays, now) }, now);
}
