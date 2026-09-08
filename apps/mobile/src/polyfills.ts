/**
 * Runtime polyfills for Hermes. Imported as the very first statement of
 * `index.ts`, before `expo-router/entry`.
 *
 * Hermes ships neither WebCrypto nor the encoding APIs, and viem/ox/noble all
 * reach for them the moment they are imported. Installing these late produces
 * errors far from the cause ("crypto.getRandomValues is not a function" from
 * inside a bundled dependency), so ordering here is load-bearing.
 */

// TextEncoder / TextDecoder — used by viem's hex and ABI encoding paths.
import 'fast-text-encoding';

// Installs a getRandomValues backed by the native RN module. Kept as a second
// line of defence: on some Hermes builds it lands before ours, on others it
// no-ops, so we assert our own implementation below regardless.
import 'react-native-get-random-values';

import { getRandomValues } from 'expo-crypto';

type MinimalCrypto = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T) => T;
  randomUUID?: () => string;
};

const globalScope = globalThis as typeof globalThis & { crypto?: MinimalCrypto };

if (globalScope.crypto == null) {
  // `crypto` is a non-writable accessor on some engines; defining it is the
  // only reliable way to install one.
  Object.defineProperty(globalScope, 'crypto', {
    value: {} as MinimalCrypto,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

const cryptoRef = globalScope.crypto as MinimalCrypto;

if (typeof cryptoRef.getRandomValues !== 'function') {
  // expo-crypto's getRandomValues fills the view in place and returns it,
  // matching the WebCrypto signature.
  cryptoRef.getRandomValues = getRandomValues as MinimalCrypto['getRandomValues'];
}

if (typeof cryptoRef.randomUUID !== 'function') {
  cryptoRef.randomUUID = () => {
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    // RFC 4122 version 4 / variant 10xx.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  };
}

export {};
