/**
 * The draft `app/presets/[id]/configure.tsx` keeps (SEN-190): the strategy
 * params, mandate and review fields typed before the preset is hired.
 *
 * Keyed per preset id (`draftStore.ts`'s `{ kind: 'preset' }`), so configuring
 * Guardian and Range Trader in the same session keeps two independent drafts
 * rather than one overwriting the other.
 *
 * Plain node, no React Native, so `presetDraft.test.ts` runs without a device.
 */
import type { ParamValue } from '@sente/presets';

import type { Draft as ParamsDraft } from '../presets/params.ts';
import {
  isMandateForm,
  isPresetChoice,
  keepLiveReturnTo,
  parseDraftPayload,
  serializeDraftPayload,
} from './draftStore.ts';
import type { MandateForm } from './mandate.ts';
import type { PresetChoice } from './presets.ts';

export type PresetStep = 'strategy' | 'mandate' | 'review';
const PRESET_STEPS: readonly PresetStep[] = ['strategy', 'mandate', 'review'];

export type PresetDraftFields = {
  step: PresetStep;
  draft: ParamsDraft;
  form: MandateForm;
  /** `null` keeps `form.expiresAt` as is, same meaning as the screen's own state. */
  expiryDays: number | null;
  tier: PresetChoice;
  name: string;
  model: string;
  fundSymbol: string | null;
  /** `null` means "not yet typed" — the screen falls back to its own suggestion. */
  fundAmount: string | null;
};

function isParamValue(value: unknown): value is ParamValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isParamsDraft(value: unknown): value is ParamsDraft {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every(isParamValue)
  );
}

export function isPresetDraftFields(value: unknown): value is PresetDraftFields {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.step === 'string' &&
    (PRESET_STEPS as readonly string[]).includes(d.step) &&
    isParamsDraft(d.draft) &&
    isMandateForm(d.form) &&
    (d.expiryDays === null || typeof d.expiryDays === 'number') &&
    isPresetChoice(d.tier) &&
    typeof d.name === 'string' &&
    typeof d.model === 'string' &&
    (d.fundSymbol === null || typeof d.fundSymbol === 'string') &&
    (d.fundAmount === null || typeof d.fundAmount === 'string')
  );
}

export function serializePresetDraft(fields: PresetDraftFields): string {
  return serializeDraftPayload(fields);
}

/** `null` for anything that isn't exactly today's shape — see `draftStore.ts`. */
export function parsePresetDraft(raw: string | null): PresetDraftFields | null {
  return parseDraftPayload(raw, isPresetDraftFields);
}

/**
 * The restored draft laid over a freshly built default — every field is the
 * draft's except `form.returnTo`, which always follows the live wallet
 * (`draftStore.ts`'s `keepLiveReturnTo`).
 */
export function mergePresetDraft(
  defaults: PresetDraftFields,
  draft: PresetDraftFields | null,
): PresetDraftFields {
  return draft ? keepLiveReturnTo(defaults, draft) : defaults;
}

/**
 * A stable reference for `useDraftSync`, so passing it doesn't restart the
 * read effect. Unlike `hireDraft.ts`'s codec, there is no "untouched" shape
 * worth skipping here: a preset's strategy params start prefilled with real
 * suggested values (`initialDraft`), not blank fields, so there is nothing
 * to tell an unedited draft apart from one worth keeping — every save writes.
 */
export const PRESET_DRAFT_CODEC = {
  serialize: serializePresetDraft,
  parse: parsePresetDraft,
  isEmpty: () => false,
};
