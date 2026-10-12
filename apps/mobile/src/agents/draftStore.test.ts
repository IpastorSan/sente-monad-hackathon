/**
 * The draft envelope's own rules: the key one wallet's drafts live under,
 * and the version check that drops anything that isn't exactly today's
 * shape.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address } from 'viem';

import {
  DRAFT_PAYLOAD_VERSION,
  draftKey,
  isMandateForm,
  isPresetChoice,
  keepLiveReturnTo,
  parseDraftPayload,
  serializeDraftPayload,
} from './draftStore.ts';
import { defaultMandateForm, type MandateForm } from './mandate.ts';
import { PRESET_CHOICES } from './presets.ts';

test('draftKey scopes a blank hire to the lowercased wallet', () => {
  assert.equal(
    draftKey('0xABCDEF0000000000000000000000000000dEaD', { kind: 'hire' }),
    'sente.hire-draft.v1.0xabcdef0000000000000000000000000000dead',
  );
});

test('draftKey keeps a fork draft and a preset draft apart from the blank hire and each other', () => {
  const owner = '0xabc';
  const hire = draftKey(owner, { kind: 'hire' });
  const fork = draftKey(owner, { kind: 'fork', source: 'agent-1' });
  const presetA = draftKey(owner, { kind: 'preset', presetId: 'guardian' });
  const presetB = draftKey(owner, { kind: 'preset', presetId: 'range-trader' });
  const keys = new Set([hire, fork, presetA, presetB]);
  assert.equal(keys.size, 4);
  assert.equal(fork, 'sente.hire-draft.v1.0xabc.fork.agent-1');
  assert.equal(presetA, 'sente.hire-draft.v1.0xabc.preset.guardian');
});

test('draftKey encodes a scope part that would otherwise break the key', () => {
  const key = draftKey('0xabc', { kind: 'fork', source: 'agent/weird.id' });
  assert.equal(key, 'sente.hire-draft.v1.0xabc.fork.agent%2Fweird.id');
});

type Payload = { name: string };
const isPayload = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && typeof (value as Payload).name === 'string';

test('serializeDraftPayload / parseDraftPayload round-trip', () => {
  const raw = serializeDraftPayload<Payload>({ name: 'Night desk' });
  assert.deepEqual(parseDraftPayload(raw, isPayload), { name: 'Night desk' });
});

test('parseDraftPayload refuses corrupt JSON', () => {
  assert.equal(parseDraftPayload('{not json', isPayload), null);
  assert.equal(parseDraftPayload('null', isPayload), null);
  assert.equal(parseDraftPayload('"a string, not an envelope"', isPayload), null);
});

test('parseDraftPayload refuses a version it does not recognise', () => {
  const other = JSON.stringify({ v: DRAFT_PAYLOAD_VERSION + 1, data: { name: 'x' } });
  assert.equal(parseDraftPayload(other, isPayload), null);
  const missing = JSON.stringify({ data: { name: 'x' } });
  assert.equal(parseDraftPayload(missing, isPayload), null);
});

test('parseDraftPayload refuses a payload the validator rejects', () => {
  const wrongShape = JSON.stringify({ v: DRAFT_PAYLOAD_VERSION, data: { name: 42 } });
  assert.equal(parseDraftPayload(wrongShape, isPayload), null);
});

test('parseDraftPayload returns null for no draft at all', () => {
  assert.equal(parseDraftPayload(null, isPayload), null);
});

test('isPresetChoice accepts exactly every value PRESET_CHOICES lists, and nothing else', () => {
  for (const { value } of PRESET_CHOICES) assert.equal(isPresetChoice(value), true);
  assert.equal(isPresetChoice('exotic'), false);
  assert.equal(isPresetChoice(42), false);
  assert.equal(isPresetChoice(null), false);
});

test('isMandateForm accepts a real MandateForm and rejects one field at a time', () => {
  const form = defaultMandateForm(1_789_000_000);
  assert.equal(isMandateForm(form), true);
  assert.equal(isMandateForm({ ...form, kuru: 'yes' }), false);
  assert.equal(isMandateForm({ ...form, kuruMarkets: [1, 2] }), false);
  assert.equal(isMandateForm({ ...form, depositCaps: { USDC: 100 } }), false);
  assert.equal(isMandateForm({ ...form, expiresAt: '123' }), false);
  assert.equal(isMandateForm(null), false);
  assert.equal(isMandateForm('a mandate form'), false);
});

test('isMandateForm accepts returnTo both present and absent', () => {
  const form = defaultMandateForm(1_789_000_000);
  const { returnTo: _drop, ...withoutReturnTo } = form;
  assert.equal(isMandateForm(withoutReturnTo), true);
  assert.equal(
    isMandateForm({ ...withoutReturnTo, returnTo: '0x1111111111111111111111111111111111111111' }),
    true,
  );
  assert.equal(isMandateForm({ ...withoutReturnTo, returnTo: 42 }), false);
});

test('keepLiveReturnTo keeps every draft field but overrides returnTo with the live wallet', () => {
  const staleWallet: Address = '0x1111111111111111111111111111111111111111';
  const liveWallet: Address = '0x2222222222222222222222222222222222222222';
  type Labelled = { label: string; form: MandateForm };
  const draft: Labelled = {
    label: 'draft',
    form: { ...defaultMandateForm(0), returnTo: staleWallet },
  };
  const defaults: Labelled = {
    label: 'defaults',
    form: { ...defaultMandateForm(0), returnTo: liveWallet },
  };

  const merged = keepLiveReturnTo(defaults, draft);

  assert.equal(merged.label, 'draft');
  assert.equal(merged.form.returnTo, liveWallet);
});
