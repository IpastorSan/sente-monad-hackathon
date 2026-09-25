/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads config plugins with CommonJS require at prebuild time; this file is build tooling, not app code. */
// Expo config plugin: the app's half of the passkey association.
//
// Android's Credential Manager checks the link between an app and its passkey
// domain from BOTH sides. The website vouches for the app in
// /.well-known/assetlinks.json; the app vouches for the website with an
// `asset_statements` string and a manifest <meta-data> pointing at it. The
// official prerequisites page shows both, and a device that walks the
// framework path (Android 14+) reads this half. Without it the ceremony can
// fail with "RP ID cannot be validated" even though Google's own check API
// says the website side is linked — measured on a real phone, SEN-12.
//
// `android/` is generated and gitignored, so this is the only place the
// declaration can live and survive `expo prebuild --clean`.
//
// The value is Android resource XML: the inner quotes MUST be escaped as \",
// or aapt treats them as quoting and strips them, leaving invalid JSON.

const { withAndroidManifest, withStringsXml, AndroidConfig } = require('expo/config-plugins');

const RP_ID = 'sente.lol';
const ASSET_LINKS_URL = `https://${RP_ID}/.well-known/assetlinks.json`;
const STRING_NAME = 'asset_statements';

/** The resource value, with the quotes escaped the way strings.xml needs. */
const ASSET_STATEMENTS_VALUE = `[{\\"include\\": \\"${ASSET_LINKS_URL}\\"}]`;

/** Pure: adds the <meta-data> to the main <application>. Idempotent. */
function addAssetStatementsToManifest(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    app,
    STRING_NAME,
    `@string/${STRING_NAME}`,
    'resource',
  );
  return manifest;
}

/** Pure: adds (or replaces) the string resource. Idempotent. */
function addAssetStatementsString(strings) {
  return AndroidConfig.Strings.setStringItem(
    [{ $: { name: STRING_NAME, translatable: 'false' }, _: ASSET_STATEMENTS_VALUE }],
    strings,
  );
}

function withAssetStatements(config) {
  config = withAndroidManifest(config, (c) => {
    c.modResults = addAssetStatementsToManifest(c.modResults);
    return c;
  });
  config = withStringsXml(config, (c) => {
    c.modResults = addAssetStatementsString(c.modResults);
    return c;
  });
  return config;
}

module.exports = withAssetStatements;
module.exports.addAssetStatementsToManifest = addAssetStatementsToManifest;
module.exports.addAssetStatementsString = addAssetStatementsString;
module.exports.ASSET_STATEMENTS_VALUE = ASSET_STATEMENTS_VALUE;
module.exports.ASSET_LINKS_URL = ASSET_LINKS_URL;
