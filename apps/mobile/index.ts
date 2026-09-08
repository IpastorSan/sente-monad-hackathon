// DO NOT ADD AN IMPORT ABOVE THIS LINE.
//
// Hermes has no `crypto.getRandomValues` and no `TextEncoder`. viem, the
// account-abstraction stack and anything that derives a key touch both at
// *module evaluation* time, so the polyfills have to be installed before any
// of that is imported — including transitively via expo-router's route tree.
import './src/polyfills';

import 'expo-router/entry';
