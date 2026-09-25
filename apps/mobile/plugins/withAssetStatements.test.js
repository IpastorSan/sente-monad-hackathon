/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads config plugins with CommonJS require at prebuild time; this file is build tooling, not app code. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addAssetStatementsToManifest,
  addAssetStatementsString,
  ASSET_STATEMENTS_VALUE,
  ASSET_LINKS_URL,
} = require('./withAssetStatements');

const manifest = () => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    application: [{ $: { 'android:name': '.MainApplication' } }],
  },
});

test('the meta-data points the platform at the string resource', () => {
  const m = addAssetStatementsToManifest(manifest());
  const meta = m.manifest.application[0]['meta-data'];
  assert.deepEqual(meta, [
    { $: { 'android:name': 'asset_statements', 'android:resource': '@string/asset_statements' } },
  ]);
});

test('applying it twice adds it once', () => {
  const m = addAssetStatementsToManifest(addAssetStatementsToManifest(manifest()));
  assert.equal(m.manifest.application[0]['meta-data'].length, 1);
});

test('the string names the real assetlinks URL, quotes escaped for strings.xml', () => {
  const s = addAssetStatementsString({ resources: { string: [] } });
  const item = s.resources.string.find((x) => x.$.name === 'asset_statements');
  assert.ok(item, 'string present');
  assert.equal(item.$.translatable, 'false');
  assert.equal(item._, ASSET_STATEMENTS_VALUE);
  assert.ok(item._.includes('\\"include\\"'), 'inner quotes are escaped');
  assert.ok(ASSET_LINKS_URL.startsWith('https://sente.lol/'), 'the permanent rpId');
  // Unescaped, it must be valid JSON that includes exactly that URL.
  const parsed = JSON.parse(item._.replace(/\\"/g, '"'));
  assert.deepEqual(parsed, [{ include: 'https://sente.lol/.well-known/assetlinks.json' }]);
});

test('re-applying the string replaces rather than duplicates', () => {
  const s = addAssetStatementsString(addAssetStatementsString({ resources: { string: [] } }));
  assert.equal(s.resources.string.filter((x) => x.$.name === 'asset_statements').length, 1);
});
