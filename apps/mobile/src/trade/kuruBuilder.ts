/**
 * The Sente builder fee this build accepts on Kuru (SEN-184).
 *
 * A Kuru order can pay a "builder" a share of its notional through the
 * `builderConfig(builder, feePps)` overload of `batch`, once the account has
 * approved that builder with `AccountCore.approveBuilder`. Sente charges its
 * fee that way. The device key signs blindly, so WHO is paid and HOW MUCH is
 * pinned here, at build time, and never taken from the server:
 *
 * - `EXPO_PUBLIC_KURU_BUILDER_ADDRESS` — the treasury. Unset: this build
 *   refuses every builder order and every builder approval.
 * - `EXPO_PUBLIC_KURU_BUILDER_FEE_PPS` — the rate, parts per ten million;
 *   10000 (0.10%) when unset, the API's own default. Above 10000 the pin is
 *   void and every builder leg is refused.
 *
 * The verifier (`verifyKuru.ts`) accepts a builder order only at exactly this
 * builder and rate, and an approval only for this builder, at most this rate,
 * expiring within `BUILDER_APPROVAL_MAX_SECONDS` (`@sente/venues/kuru`). `GET /trade/capabilities`
 * names the server's builder; `kuruBuilderAgrees` turns manual Kuru trading
 * off when the two differ, so a deploy that changed the fee without an app
 * release reads as "trading off", not as a refusal at the signature.
 *
 * Perpl trades carry no Sente fee.
 *
 * Pure TS: `kuruBuilder.test.ts` runs under plain node.
 */
import {
  builderFeeAtoms,
  SENTE_MAX_BUILDER_FEE_PPS,
  type KuruBuilderFee,
} from '@sente/venues/kuru';
import { getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';

export type KuruBuilderPin = KuruBuilderFee;

/**
 * The pin from the two build variables. `null` — refuse every builder leg —
 * when the address is unset, malformed or zero, or the rate is not a whole
 * number in 1..{@link SENTE_MAX_BUILDER_FEE_PPS}: a broken pin must fail closed, and
 * throwing at module load would take the whole app down instead.
 */
export function parseKuruBuilderPin(
  rawAddress: string | undefined,
  rawFeePps: string | undefined,
): KuruBuilderPin | null {
  const address = rawAddress?.trim();
  if (!address || !isAddress(address, { strict: false })) return null;
  if (isAddressEqual(address, zeroAddress)) return null;
  const text = rawFeePps?.trim() || String(SENTE_MAX_BUILDER_FEE_PPS);
  if (!/^\d{1,9}$/.test(text)) return null;
  const feePps = Number(text);
  if (feePps <= 0 || feePps > SENTE_MAX_BUILDER_FEE_PPS) return null;
  return { address: getAddress(address), feePps };
}

/**
 * This build's pin. Each `process.env.EXPO_PUBLIC_*` is written out in full
 * because Expo inlines only literal references.
 */
export const KURU_BUILDER_PIN: KuruBuilderPin | null = parseKuruBuilderPin(
  process.env.EXPO_PUBLIC_KURU_BUILDER_ADDRESS,
  process.env.EXPO_PUBLIC_KURU_BUILDER_FEE_PPS,
);

/**
 * Whether the server's builder (from `/trade/capabilities`) is this build's.
 * Both off agrees; an API older than SEN-184 sends none, which reads as off.
 */
export function kuruBuilderAgrees(
  server: { readonly address: string; readonly feePps: number } | null | undefined,
  pin: KuruBuilderPin | null,
): boolean {
  if (!server || !pin) return !server && !pin;
  return (
    isAddress(server.address, { strict: false }) &&
    isAddressEqual(server.address, pin.address) &&
    server.feePps === pin.feePps
  );
}

/**
 * The Sente fee on `notionalAtoms` of quote, rounded up — what the ticket
 * shows as "≈" before anything is prepared. A resting order that never takes
 * may pay less.
 */
export function senteFeeEstimateAtoms(notionalAtoms: bigint, pin: KuruBuilderPin): bigint {
  return builderFeeAtoms(notionalAtoms, pin.feePps);
}

/** `pps` as a percentage for copy: 10000 → "0.1". */
export function feePpsToPercent(feePps: number): string {
  return String(feePps / 100_000);
}

/** The Sente fee a prepared Kuru place carries, from its render-only summary. */
export type SenteFeeView = {
  readonly bps: string;
  readonly pps: string;
  /** Estimated amount, a decimal string in `asset`. */
  readonly estimate: string;
  readonly asset: string;
};

/**
 * Reads the planner's `senteFee*` summary keys (SEN-184), or `null` when the
 * trade carries no Sente fee. Display only, like the summary itself: what the
 * user pays is bounded by the verifier against {@link KURU_BUILDER_PIN}.
 */
export function senteFeeOf(summary: Readonly<Record<string, string>>): SenteFeeView | null {
  const { senteFeeBps, senteFeePps, senteFee, senteFeeAsset } = summary;
  if (!senteFeeBps || !senteFeePps || !senteFee || !senteFeeAsset) return null;
  return { bps: senteFeeBps, pps: senteFeePps, estimate: senteFee, asset: senteFeeAsset };
}
