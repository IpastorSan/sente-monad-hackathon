/**
 * Handler registration entry point.
 *
 * Envio auto-loads every handler file under `handlers: ./src` recursively — its
 * loader globs `src/**` for js/mjs/ts files and skips `*.test.ts` — so the file
 * below is loaded on its own and the import here is redundant at runtime. It
 * exists so the registrations have one obvious, documented entry point:
 * `src/handlers/<venue>.ts` names a venue, this file names the registry.
 *
 * Kuru is the only venue indexed; why Perpl is not is in docs/indexer.md
 * §budget.
 */
import './handlers/kuru.ts';
