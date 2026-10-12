/**
 * The envelope every hire/fork/preset draft is saved in (SEN-190), and the
 * `platform/kv` key that scopes one to its signed-in wallet.
 *
 * A draft is never a secret — it is the strategy, prompt and mandate someone
 * is still drafting, not a key or a token — so it belongs in `platform/kv`,
 * the same store that already holds sign-in hints and UI flags, not
 * `expo-secure-store` reserved for key material.
 *
 * The envelope carries its own version (`DRAFT_PAYLOAD_VERSION`): a draft
 * written by an older or newer build of this screen is dropped rather than
 * half-applied, exactly like `alerts.ts`'s `parseSeen`. Bump the version
 * whenever a draft's shape changes in a way an old reader could misread;
 * never reuse a number.
 *
 * Plain node, no React Native, so `draftStore.test.ts` runs without a device.
 */
import type { MandateForm } from './mandate.ts';
import { PRESET_CHOICES, type PresetChoice } from './presets.ts';

/** The shape every draft is wrapped in before it reaches `platform/kv`. */
export const DRAFT_PAYLOAD_VERSION = 1;

export type DraftScope =
  { kind: 'hire' } | { kind: 'fork'; source: string } | { kind: 'preset'; presetId: string };

/**
 * `sente.hire-draft.v1.<lowercase address>[.fork.<source>|.preset.<id>]` —
 * one draft per signed-in wallet for a blank hire, and a separate one per
 * source agent or preset so forking one agent, or configuring one preset,
 * never clobbers another's draft or the blank hire's.
 *
 * `v1` here is the KEY's own namespace (never renamed, like the PRF salts);
 * `DRAFT_PAYLOAD_VERSION` below is the independent, bumpable version of what
 * is stored under it.
 */
export function draftKey(address: string, scope: DraftScope): string {
  const owner = address.toLowerCase();
  switch (scope.kind) {
    case 'hire':
      return `sente.hire-draft.v1.${owner}`;
    case 'fork':
      return `sente.hire-draft.v1.${owner}.fork.${encodeURIComponent(scope.source)}`;
    case 'preset':
      return `sente.hire-draft.v1.${owner}.preset.${encodeURIComponent(scope.presetId)}`;
  }
}

/** `{ v, data }`, so a reader can refuse a shape it no longer understands. */
export function serializeDraftPayload<T>(data: T): string {
  return JSON.stringify({ v: DRAFT_PAYLOAD_VERSION, data });
}

/**
 * `null` for anything that isn't exactly today's shape: missing, corrupt JSON,
 * a version from another build, or a `data` the validator rejects. A draft is
 * convenience, never a source of truth, so refusing to guess beats restoring
 * something half right.
 */
export function parseDraftPayload<T>(
  raw: string | null,
  isValid: (data: unknown) => data is T,
): T | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { v?: unknown; data?: unknown };
  if (envelope.v !== DRAFT_PAYLOAD_VERSION) return null;
  return isValid(envelope.data) ? (envelope.data as T) : null;
}

// ─── Guards shared by every draft shape (`hireDraft.ts`, `presetDraft.ts`) ──
// Both drafts carry a `MandateForm` and a `PresetChoice`/tier, so the guards
// for those two live once here rather than twice, byte for byte, in each.

const PRESET_CHOICE_VALUES: readonly string[] = PRESET_CHOICES.map((choice) => choice.value);

export function isPresetChoice(value: unknown): value is PresetChoice {
  return typeof value === 'string' && PRESET_CHOICE_VALUES.includes(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}

export function isMandateForm(value: unknown): value is MandateForm {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.kuru === 'boolean' &&
    typeof f.perpl === 'boolean' &&
    Array.isArray(f.kuruMarkets) &&
    f.kuruMarkets.every((m) => typeof m === 'string') &&
    isStringRecord(f.depositCaps) &&
    typeof f.perplCollateral === 'string' &&
    typeof f.perplMarkets === 'string' &&
    typeof f.maxLeverage === 'string' &&
    typeof f.maxOrderNotional === 'string' &&
    typeof f.expiresAt === 'number' &&
    (f.returnTo === undefined || typeof f.returnTo === 'string')
  );
}

/**
 * `form.returnTo` always follows the live wallet (`defaults`), never a draft's
 * own saved value: a draft saved before the wallet registered — or from a
 * session that has since signed out — must never freeze a stale or foreign
 * exit address into the mandate that gets sent. Every other field is the
 * draft's.
 */
export function keepLiveReturnTo<T extends { form: MandateForm }>(defaults: T, draft: T): T {
  return { ...draft, form: { ...draft.form, returnTo: defaults.form.returnTo } };
}
