// Copy a STATE_DIR's JSON files into its sente.db (SEN-205).
//
//   pnpm --filter @sente/api run state:import-sqlite
//   pnpm --filter @sente/api run state:import-sqlite -- --state-dir /var/lib/sente/state
//
// The cut-over from STORE_BACKEND=file to sqlite (docs/state.md): stop the API,
// run this, start it with STORE_BACKEND=sqlite. Idempotent — every record is
// an upsert by key — and the JSON files are left as they are, so the rollback
// is STORE_BACKEND=file. It takes the STATE_DIR lock and refuses while the API
// (or any other holder) has it; it exits 1 when a store's verification finds a
// file record missing from, or different in, the table.
//
// The directory comes from --state-dir, else STATE_DIR in the environment,
// else STATE_DIR in the repo-root .env (or --env-file). On the box, where there
// is no scripts/, the same command is `node dist/state-import-sqlite.js`
// (docs/state.md, "Cut-over and rollback").

import { STATE_DIR_VAR } from '../src/state/json-file.ts';
import { runStateImport } from '../src/state/db/state-import-cli.ts';
import { envFileFromArgs, readVar } from './env-file.ts';

runStateImport(process.argv.slice(2), () => readVar(envFileFromArgs(), STATE_DIR_VAR)).then(
  (code) => process.exit(code),
);
