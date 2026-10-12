/**
 * The draft `app/presets/[id]/configure.tsx` keeps: serialize/parse
 * round-trip, and the merge that always keeps the live wallet's `returnTo`
 * over whatever a draft saved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultMandateForm } from './mandate.ts';
import {
  isPresetDraftFields,
  mergePresetDraft,
  parsePresetDraft,
  serializePresetDraft,
  type PresetDraftFields,
} from './presetDraft.ts';

const NOW = 1_789_000_000;

function fields(patch: Partial<PresetDraftFields> = {}): PresetDraftFields {
  return {
    step: 'strategy',
    draft: { sellAbove: '4.2', sellBelow: '3.1', markets: ['MON-USDC'], autoRebalance: true },
    form: defaultMandateForm(NOW),
    expiryDays: 7,
    tier: 'standard',
    name: 'Guardian',
    model: 'gpt-5',
    fundSymbol: 'USDC',
    fundAmount: '100',
    ...patch,
  };
}

test('serializePresetDraft / parsePresetDraft round-trip', () => {
  const draft = fields();
  assert.deepEqual(parsePresetDraft(serializePresetDraft(draft)), draft);
});

test('parsePresetDraft refuses corrupt JSON and a version it does not recognise', () => {
  assert.equal(parsePresetDraft('{not json'), null);
  assert.equal(parsePresetDraft(null), null);
  const otherVersion = JSON.stringify({ v: 2, data: fields() });
  assert.equal(parsePresetDraft(otherVersion), null);
});

test('parsePresetDraft refuses a step outside the three the screen has, and a draft param of the wrong type', () => {
  assert.equal(
    parsePresetDraft(JSON.stringify({ v: 1, data: { ...fields(), step: 'nowhere' } })),
    null,
  );
  assert.equal(
    parsePresetDraft(
      JSON.stringify({ v: 1, data: { ...fields(), draft: { sellAbove: { nested: true } } } }),
    ),
    null,
  );
});

test('isPresetDraftFields accepts every ParamValue shape: string, number, boolean, string[]', () => {
  const draft = fields({
    draft: { a: 'text', b: 3, c: false, d: ['one', 'two'] },
  });
  assert.equal(isPresetDraftFields(draft), true);
});

test('mergePresetDraft with no draft falls back to the defaults untouched', () => {
  const defaults = fields({ name: 'Range Trader' });
  assert.deepEqual(mergePresetDraft(defaults, null), defaults);
});

test('mergePresetDraft keeps every draft field except returnTo, which always follows the live wallet', () => {
  const staleWallet = '0x1111111111111111111111111111111111111111' as const;
  const liveWallet = '0x2222222222222222222222222222222222222222' as const;
  const draft = fields({ form: { ...defaultMandateForm(NOW), returnTo: staleWallet } });
  const defaults = fields({
    name: 'Range Trader',
    form: { ...defaultMandateForm(NOW), returnTo: liveWallet },
  });

  const merged = mergePresetDraft(defaults, draft);

  assert.equal(merged.name, draft.name);
  assert.equal(merged.form.returnTo, liveWallet);
});
