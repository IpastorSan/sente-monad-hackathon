// Learn more: https://docs.expo.dev/guides/customizing-metro
const fs = require('fs');
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

// ---------------------------------------------------------------------------
// Workspace packages (CLAUDE.md gotcha 10) are TypeScript sources behind an
// exports map — `types`/`source` -> src/, `default` -> dist/ — so with package
// exports off they need the same per-subpath alias as mera.
//
// The alias targets the `source` condition, not dist/: Metro and Babel already
// compile TypeScript, so the app needs no prior package build and can never
// bundle a stale dist/. The sources import each other as `./x.ts`, which Metro
// resolves literally (it tries the exact path before appending extensions).
//
// The file comes from the package's own exports map, and the package is found
// on node's lookup path, so this works in both the hoisted and the isolated
// pnpm layout. Add one line per subpath the app imports.
// ---------------------------------------------------------------------------
function workspaceSource(pkg, subpath) {
  const dir = (require.resolve.paths(pkg) ?? [])
    .map((base) => path.join(base, pkg))
    .find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (dir === undefined) throw new Error(`metro.config.js: cannot find ${pkg}`);
  const entry = require(path.join(dir, 'package.json')).exports?.[subpath]?.source;
  if (typeof entry !== 'string') {
    throw new Error(`metro.config.js: ${pkg} exports no "source" condition for ${subpath}`);
  }
  return fs.realpathSync(path.join(dir, entry));
}

const ALIASES = {
  '@category-labs/mera': path.join(meraDist, 'index.js'),
  '@category-labs/mera/viem': path.join(meraDist, 'viem.js'),
  '@category-labs/mera/react-native-webauthn-client': path.join(
    meraDist,
    'react-native-webauthn-client.js',
  ),
  // The Kuru market and token tables for the hire form (SEN-10).
  '@sente/venues/kuru': workspaceSource('@sente/venues', './kuru'),
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
