// Learn more: https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// REQUIRED. `isows` (pulled in by viem) and zustand@4 publish `exports` maps
// that Metro resolves to browser/node builds React Native cannot execute,
// producing runtime "Cannot read property ... of undefined" errors that look
// nothing like a resolution problem. Every RN crypto stack hits this.
// Leave false unless the whole dependency graph has been re-verified.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
