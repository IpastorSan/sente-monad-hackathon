/**
 * Handler registration entry point.
 *
 * Envio auto-loads every handler file under `handlers: ./src` recursively — its
 * loader globs `src/**` for js/mjs/ts files and skips `*.test.ts` — so the two
 * files below are loaded on their own and the imports here are redundant at
 * runtime. They exist so the registrations have one obvious, documented entry
 * point: `src/handlers/<venue>.ts` names a venue, this file names the registry.
 *
 * Order within a file is log order within a block, and the Perpl attribution
 * depends on it: `OrderRequestV2` must register before the fill handlers so its
 * row is written first (see src/lib/perpl.ts).
 */
import './handlers/kuru.ts';
import './handlers/perpl.ts';
