/**
 * The preset a hire is configured against (SEN-160): the server's version
 * wins, a missing route falls back to the bundle, and a served param this
 * build can't render stops the hire before anything is sent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPreset, type PresetDefinition } from '@sente/presets';

import { PresetsApi, type PresetDto } from './api.ts';
import { presetToDto } from './catalog.ts';
import { checkParams, initialDraft } from './params.ts';
import { hirePresetFrom, loadHirePreset } from './served.ts';

function bundled(id: string): PresetDefinition {
  const def = getPreset(id);
  assert.ok(def, `bundled preset ${id}`);
  return def;
}

/** The bundled preset as the server would serve it after a version bump. */
function bumped(id: string, change: (dto: PresetDto) => void = () => undefined): PresetDto {
  const dto = structuredClone(presetToDto(bundled(id)));
  dto.version += 1;
  change(dto);
  return dto;
}

function api(status: number, body: unknown) {
  const calls: { url: string; method: string | undefined }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  const client = new PresetsApi({
    auth: { token: () => 'tok', refresh: () => Promise.resolve('tok') },
    baseUrl: 'http://api.test',
    fetchImpl,
  });
  return { client, calls };
}

test('the server’s version wins over the bundle’s', async () => {
  const served = bumped('range-trader');
  const { client } = api(200, { presets: [served] });
  const hire = await loadHirePreset(client, 'range-trader');
  assert.equal(hire.kind, 'ready');
  if (hire.kind !== 'ready') return;
  assert.equal(hire.source, 'api');
  assert.equal(hire.def.version, bundled('range-trader').version + 1);
  assert.deepEqual(hire.dto, served);
});

test('validation runs resolveParams on the served specs, not the bundled ones', () => {
  const served = bumped('range-trader', (dto) => {
    const target = dto.params.find((spec) => spec.key === 'target');
    assert.ok(target?.type === 'number');
    target.max = target.default; // the server narrowed the range
  });
  const hire = hirePresetFrom('range-trader', [served]);
  assert.equal(hire.kind, 'ready');
  if (hire.kind !== 'ready') return;
  const draft = initialDraft(hire.def);
  const target = draft['target'];
  assert.equal(typeof target, 'number');
  const above = { ...draft, target: (target as number) + 1 };
  assert.equal(checkParams(hire.def, draft).ok, true);
  const refused = checkParams(hire.def, above);
  assert.equal(refused.ok, false);
  // The bundle alone would still have allowed it.
  assert.equal(checkParams(bundled('range-trader'), above).ok, true);
});

test('at the defaults the server’s suggested mandate and cadence answer', () => {
  const served = bumped('dca-stacker', (dto) => {
    dto.defaults.suggestedMandate.softRules = ['served rule'];
    dto.defaults.suggestedCadenceSeconds = 1_800;
  });
  const hire = hirePresetFrom('dca-stacker', [served]);
  assert.equal(hire.kind, 'ready');
  if (hire.kind !== 'ready') return;
  const checked = checkParams(hire.def, initialDraft(hire.def));
  assert.ok(checked.ok);
  assert.deepEqual(hire.def.suggestedMandate(checked.params).softRules, ['served rule']);
  assert.equal(hire.def.suggestedCadenceSeconds(checked.params), 1_800);
});

test('a missing route falls back to the bundle', async () => {
  const { client } = api(404, { statusCode: 404, message: 'Cannot GET /presets' });
  const hire = await loadHirePreset(client, 'guardian');
  assert.equal(hire.kind, 'ready');
  if (hire.kind !== 'ready') return;
  assert.equal(hire.source, 'bundled');
  assert.equal(hire.def, bundled('guardian'));
});

test('any other failure is thrown, not guessed from the bundle', async () => {
  const { client } = api(500, { statusCode: 500, message: 'boom' });
  await assert.rejects(loadHirePreset(client, 'guardian'));
});

test('no session asks nothing and uses the bundle', async () => {
  const hire = await loadHirePreset(null, 'guardian');
  assert.equal(hire.kind, 'ready');
  assert.equal(hire.kind === 'ready' && hire.source, 'bundled');
});

test('a served param of an unknown type asks for an update, and nothing is sent', async () => {
  const served = bumped('range-trader', (dto) => {
    const target = dto.params.find((spec) => spec.key === 'target');
    assert.ok(target);
    (target as { type: string }).type = 'curve';
  });
  const { client, calls } = api(200, { presets: [served] });
  const hire = await loadHirePreset(client, 'range-trader');
  assert.equal(hire.kind, 'update-app');
  assert.equal(hire.kind === 'update-app' && hire.dto.version, served.version);
  // Only the catalog was read; there is no definition to hire with.
  assert.deepEqual(calls, [{ url: 'http://api.test/presets', method: 'GET' }]);
});

test('a served param with a key this build doesn’t know asks for an update', () => {
  const served = bumped('guardian', (dto) => {
    dto.params.push({ key: 'cooldown', label: 'Cooldown', type: 'boolean', default: false });
  });
  assert.equal(hirePresetFrom('guardian', [served]).kind, 'update-app');
});

test('a preset the bundle has never heard of asks for an update', () => {
  const served = bumped('guardian', (dto) => {
    dto.id = 'grid-trader';
  });
  assert.equal(hirePresetFrom('grid-trader', [served]).kind, 'update-app');
});

test('a preset the server doesn’t serve is missing, even if the bundle has it', () => {
  assert.equal(hirePresetFrom('guardian', [bumped('dca-stacker')]).kind, 'missing');
});
