// DO NOT ADD AN IMPORT ABOVE THIS LINE.
//
// Web twin of `index.ts` (SEN-164). Metro picks this file over `index.ts` when
// it bundles for web; the native entry is untouched (CLAUDE.md gotcha 3).
//
// The polyfills stay first for the same reason as on native: viem and the key
// derivation touch them at module evaluation time.
import './src/polyfills';

// Skia on web is CanvasKit (WASM), and nothing Skia draws works until it has
// loaded: the price chart (`ui/chart/Chart.tsx`, the one web canvas left since
// SEN-173) builds paths with `Skia.Path`, and without this it throws. Load it
// BEFORE the router is imported, then import the router dynamically so no
// route module is evaluated against a missing `global.CanvasKit`.
//
// The deep import is deliberate: Metro package exports are off (gotcha 2), so
// Skia's web loader is reached by its file path, not by an exports subpath.
//
// `canvaskit.wasm` is not committed. `pnpm run setup:web` copies it from the
// installed `canvaskit-wasm` into `public/`, which Expo serves at `/` and
// copies into the export root; `web` and `export:web` run it first, so the
// WASM always matches the installed CanvasKit JS.
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

void LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(
  // `expo-router/entry` is a side-effect module with no type declarations;
  // `index.ts` gets away with that because a bare `import '…'` is not checked.
  // @ts-expect-error TS7016: untyped side-effect module.
  () => import('expo-router/entry'),
);
