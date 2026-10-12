/**
 * The hire/fork draft `app/agents/new.tsx` keeps (SEN-190): everything typed
 * before the agent exists, so writing a long strategy, going back a step and
 * closing doesn't lose it.
 *
 * Only pre-hire form state lives here — never `hired`, `mcpToken` or anything
 * else that only exists once the agent is real, and never a secret: the
 * system prompt and strategy are the user's own words, not key material.
 *
 * `isHireDraftEmpty` is what keeps an untouched "Name your agent" screen from
 * writing (and later "restoring") a draft that is really just the form's own
 * defaults — nothing a person would recognise as theirs.
 *
 * Plain node, no React Native, so `hireDraft.test.ts` runs without a device.
 */
import {
  isMandateForm,
  isPresetChoice,
  keepLiveReturnTo,
  parseDraftPayload,
  serializeDraftPayload,
} from './draftStore.ts';
import type { MandateForm } from './mandate.ts';
import type { PresetChoice } from './presets.ts';

export type HireStep = 'identity' | 'instructions' | 'mandate' | 'review';
const HIRE_STEPS: readonly HireStep[] = ['identity', 'instructions', 'mandate', 'review'];

export type HireDraftFields = {
  step: HireStep;
  name: string;
  model: string;
  systemPrompt: string;
  strategy: string;
  isPublic: boolean;
  preset: PresetChoice;
  form: MandateForm;
  /** `null` keeps `form.expiresAt` as is, same meaning as the screen's own state. */
  expiryDays: number | null;
  /** The chosen fund-at-hire token, by symbol — never the full `Token`, which isn't JSON-stable. */
  fundSymbol: string | null;
  fundAmount: string;
  /**
   * The AUSD amount beside it when the mandate trades perps (SEN-198).
   * `null` (or absent, in a draft from before it existed): untouched, so the
   * field shows Perpl's minimum.
   */
  fundAusdAmount?: string | null;
  risksAccepted: boolean;
};

export function isHireDraftFields(value: unknown): value is HireDraftFields {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.step === 'string' &&
    (HIRE_STEPS as readonly string[]).includes(d.step) &&
    typeof d.name === 'string' &&
    typeof d.model === 'string' &&
    typeof d.systemPrompt === 'string' &&
    typeof d.strategy === 'string' &&
    typeof d.isPublic === 'boolean' &&
    isPresetChoice(d.preset) &&
    isMandateForm(d.form) &&
    (d.expiryDays === null || typeof d.expiryDays === 'number') &&
    (d.fundSymbol === null || typeof d.fundSymbol === 'string') &&
    typeof d.fundAmount === 'string' &&
    (d.fundAusdAmount === undefined ||
      d.fundAusdAmount === null ||
      typeof d.fundAusdAmount === 'string') &&
    typeof d.risksAccepted === 'boolean'
  );
}

export function serializeHireDraft(fields: HireDraftFields): string {
  return serializeDraftPayload(fields);
}

/** `null` for anything that isn't exactly today's shape — see `draftStore.ts`. */
export function parseHireDraft(raw: string | null): HireDraftFields | null {
  return parseDraftPayload(raw, isHireDraftFields);
}

/**
 * Nothing a person would call "their draft": the identity and instructions
 * steps are blank, the mandate is still whatever preset it started on, and
 * nothing was asked to fund or accepted. Gates both ends of persistence — a
 * screen that opens to exactly this writes nothing, and a stored draft that
 * degrades to this (every field cleared by hand) is deleted rather than kept.
 */
export function isHireDraftEmpty(fields: HireDraftFields): boolean {
  return (
    fields.name.trim() === '' &&
    fields.systemPrompt.trim() === '' &&
    fields.strategy.trim() === '' &&
    fields.preset === 'standard' &&
    !fields.isPublic &&
    fields.fundAmount.trim() === '' &&
    (fields.fundAusdAmount ?? null) === null &&
    !fields.risksAccepted
  );
}

/** A stable reference for `useDraftSync`, so passing it doesn't restart the read effect. */
export const HIRE_DRAFT_CODEC = {
  serialize: serializeHireDraft,
  parse: parseHireDraft,
  isEmpty: isHireDraftEmpty,
};

/**
 * The restored draft laid over a freshly built default — every field is the
 * draft's except `form.returnTo`, which always follows the live wallet
 * (`draftStore.ts`'s `keepLiveReturnTo`).
 */
export function mergeHireDraft(
  defaults: HireDraftFields,
  draft: HireDraftFields | null,
): HireDraftFields {
  return draft ? keepLiveReturnTo(defaults, draft) : defaults;
}
