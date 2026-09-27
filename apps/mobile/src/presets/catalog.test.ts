/**
 * The bundled catalog (SEN-114) must be what `GET /presets` would serve:
 * the package's own presets, in its order, evaluated at their defaults.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listPresets, renderPreset } from '@sente/presets';

import { bundledCatalog } from './catalog.ts';

test('every package preset is in the bundled catalog, in display order', () => {
  assert.deepEqual(
    bundledCatalog().map((preset) => preset.id),
    listPresets().map((def) => def.id),
  );
  assert.equal(bundledCatalog()[0]?.id, 'guardian');
});

test('defaults are the render a hire with no params would get', () => {
  for (const dto of bundledCatalog()) {
    const rendered = renderPreset(dto.id, {});
    assert.ok(rendered.ok, dto.id);
    assert.equal(dto.defaults.strategy, rendered.strategy);
    assert.equal(dto.defaults.systemPrompt, rendered.systemPrompt);
    assert.deepEqual(dto.defaults.params, { ...rendered.params });
    assert.ok(dto.defaults.suggestedCadenceSeconds >= 60, dto.id);
  }
});

test('the DTO is plain data: it survives a JSON round trip unchanged', () => {
  const catalog = bundledCatalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
});
