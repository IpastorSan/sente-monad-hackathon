// `node dist/state-import-sqlite.js [--state-dir <dir>]` (SEN-205): the
// JSON-files-to-sente.db import, compiled with the API so it runs in the
// runtime image, which carries dist/ and nothing else. On the box it runs as
// a one-off container of the api service, with the API stopped:
//
//   cd /opt/sente && sudo docker compose run --rm --no-deps api node dist/state-import-sqlite.js
//
// docs/state.md has the whole cut-over. Locally, `state:import-sqlite` is the
// same code under type stripping. Nothing imports this file.

import { runStateImport } from './state/db/state-import-cli';

void runStateImport(process.argv.slice(2)).then((code) => process.exit(code));
