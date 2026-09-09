// Learn more: https://docs.expo.dev/guides/customizing-metro
const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// REQUIRED. `isows` (pulled in by viem) and zustand@4 publish `exports` maps
// that Metro resolves to browser/node builds React Native cannot execute,
// producing runtime "Cannot read property ... of undefined" errors that look
// nothing like a resolution problem. Every RN crypto stack hits this.
// Leave false unless the whole dependency graph has been re-verified.
config.resolver.unstable_enablePackageExports = false;

// ---------------------------------------------------------------------------
// @category-labs/mera is exports-map-only: no `main`, no root `index.js`, and
// every file lives under `dist/`. With package exports off (above, and that is
// not negotiable) Metro falls back to filesystem resolution and finds nothing —
// the bare specifier and both subpaths fail with "Unable to resolve module".
//
// So alias the three entry points by hand instead of turning exports back on.
// `require.resolve` runs in node, which *does* honour the exports map, so the
// dist directory is located rather than hard-coded; only the file names below
// are assumed, and they are stable within 0.2.x.
//
// Revisit if mera ships a `main`, or if the metro flag above ever changes.
// ---------------------------------------------------------------------------
const meraDist = path.dirname(require.resolve('@category-labs/mera'));

const ALIASES = {
  '@category-labs/mera': path.join(meraDist, 'index.js'),
  '@category-labs/mera/viem': path.join(meraDist, 'viem.js'),
  '@category-labs/mera/react-native-webauthn-client': path.join(
    meraDist,
    'react-native-webauthn-client.js',
  ),
};

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const aliased = ALIASES[moduleName];
  if (aliased !== undefined) {
    return { type: 'sourceFile', filePath: aliased };
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
