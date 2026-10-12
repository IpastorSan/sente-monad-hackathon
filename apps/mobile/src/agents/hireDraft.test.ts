/**
 * The hire/fork draft `app/agents/new.tsx` keeps: serialize/parse round-trip,
 * what counts as "nothing to restore", and the merge that always keeps the
 * live wallet's `returnTo` over whatever a draft saved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isHireDraftEmpty,
  isHireDraftFields,
  mergeHireDraft,
  parseHireDraft,
  serializeHireDraft,
  type HireDraftFields,
} from './hireDraft.ts';
import { defaultMandateForm } from './mandate.ts';

const NOW = 1_789_000_000;

function fields(patch: Partial<HireDraftFields> = {}): HireDraftFields {
  return {
    step: 'instructions',
    name: 'Night desk',
    model: 'gpt-5',
    systemPrompt: 'You trade carefully.',
    strategy: 'Buy the dip, sell the rip.',
    isPublic: false,
    preset: 'standard',
    form: defaultMandateForm(NOW),
    expiryDays: 7,
    fundSymbol: 'USDC',
    fundAmount: '50',
    risksAccepted: true,
    ...patch,
  };
}

test('serializeHireDraft / parseHireDraft round-trip', () => {
  const draft = fields();
  assert.deepEqual(parseHireDraft(serializeHireDraft(draft)), draft);
});

test('parseHireDraft refuses corrupt JSON and a version it does not recognise', () => {
  assert.equal(parseHireDraft('{not json'), null);
  assert.equal(parseHireDraft(null), null);
  const otherVersion = JSON.stringify({ v: 2, data: fields() });
  assert.equal(parseHireDraft(otherVersion), null);
});

test('parseHireDraft refuses a shape that is missing or has the wrong type for a field', () => {
  const { strategy: _drop, ...withoutStrategy } = fields();
  assert.equal(parseHireDraft(JSON.stringify({ v: 1, data: withoutStrategy })), null);
  assert.equal(parseHireDraft(JSON.stringify({ v: 1, data: { ...fields(), name: 42 } })), null);
  assert.equal(
    parseHireDraft(JSON.stringify({ v: 1, data: { ...fields(), step: 'nowhere' } })),
    null,
  );
  assert.equal(
    parseHireDraft(JSON.stringify({ v: 1, data: { ...fields(), preset: 'exotic' } })),
    null,
  );
});

test('a draft from before the AUSD amount existed still restores, and a typed one round-trips', () => {
  const { fundAusdAmount: _none, ...before } = fields();
  assert.deepEqual(parseHireDraft(JSON.stringify({ v: 1, data: before })), before);
  const typed = fields({ fundAusdAmount: '150' });
  assert.deepEqual(parseHireDraft(serializeHireDraft(typed)), typed);
  assert.equal(
    parseHireDraft(JSON.stringify({ v: 1, data: { ...fields(), fundAusdAmount: 100 } })),
    null,
  );
});

test('isHireDraftFields rejects a mandate form with a field of the wrong type', () => {
  const broken = { ...fields(), form: { ...fields().form, kuru: 'yes' } };
  assert.equal(isHireDraftFields(broken), false);
});

test('isHireDraftEmpty is true only for an untouched identity/instructions/mandate step', () => {
  assert.equal(
    isHireDraftEmpty(
      fields({ name: '', systemPrompt: '', strategy: '', fundAmount: '', risksAccepted: false }),
    ),
    true,
  );
  assert.equal(isHireDraftEmpty(fields({ name: 'Night desk' })), false);
  assert.equal(isHireDraftEmpty(fields({ systemPrompt: 'Be careful' })), false);
  assert.equal(isHireDraftEmpty(fields({ strategy: 'Buy low' })), false);
  assert.equal(isHireDraftEmpty(fields({ preset: 'custom' })), false);
  assert.equal(isHireDraftEmpty(fields({ isPublic: true })), false);
  assert.equal(isHireDraftEmpty(fields({ fundAmount: '10' })), false);
  assert.equal(
    isHireDraftEmpty(
      fields({
        name: '',
        systemPrompt: '',
        strategy: '',
        fundAmount: '',
        risksAccepted: false,
        fundAusdAmount: '',
      }),
    ),
    false,
  );
  assert.equal(isHireDraftEmpty(fields({ risksAccepted: true })), false);
});

test('mergeHireDraft with no draft falls back to the defaults untouched', () => {
  const defaults = fields({ name: '' });
  assert.deepEqual(mergeHireDraft(defaults, null), defaults);
});

test('mergeHireDraft keeps every draft field except returnTo, which always follows the live wallet', () => {
  const staleWallet = '0x1111111111111111111111111111111111111111' as const;
  const liveWallet = '0x2222222222222222222222222222222222222222' as const;
  const draft = fields({ form: { ...defaultMandateForm(NOW), returnTo: staleWallet } });
  const defaults = fields({ name: '', form: { ...defaultMandateForm(NOW), returnTo: liveWallet } });

  const merged = mergeHireDraft(defaults, draft);

  assert.equal(merged.name, draft.name); // the draft's own field wins
  assert.equal(merged.form.returnTo, liveWallet); // except the exit address
});

test('mergeHireDraft drops a draft returnTo in favour of a wallet that has not registered yet', () => {
  const draft = fields({
    form: { ...defaultMandateForm(NOW), returnTo: '0x1111111111111111111111111111111111111111' },
  });
  const defaults = fields({ form: defaultMandateForm(NOW) }); // no returnTo yet

  assert.equal(mergeHireDraft(defaults, draft).form.returnTo, undefined);
});
