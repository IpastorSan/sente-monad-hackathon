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
// else STATE_DIR in the repo-root .env (or --env-file). Nothing is printed but
// paths, counts and hashes.

import { STATE_DIR_VAR } from '../src/state/json-file.ts';
import { STATE_DIR_LOCK_FILE } from '../src/state/state-dir-lock.ts';
import { importStateToSqlite, type StoreImportReport } from '../src/state/db/state-import.ts';
import { envFileFromArgs, readVar } from './env-file.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function describe(report: StoreImportReport): string {
  const file =
    report.fileCount === undefined
      ? `${report.file}: absent`
      : `${report.file}: ${report.fileCount} record(s), sha256 ${report.fileHash}`;
  const table = `${report.name}: ${report.dbCount} record(s), sha256 ${report.dbHash}`;
  const check = report.ok
    ? `OK — ${report.matched} identical${report.dbOnly ? `, ${report.dbOnly} only in the table (written under sqlite since)` : ''}`
    : `MISMATCH — ${report.matched} identical, ${report.differs} differ, ${report.missing} missing, ${report.dbOnly} only in the table${report.inOrder ? '' : ', OUT OF ORDER'}`;
  return `  ${file}\n  ${table}\n  ${check}`;
}

async function main(): Promise<number> {
  const dir =
    flag('state-dir') ??
    process.env[STATE_DIR_VAR]?.trim() ??
    readVar(envFileFromArgs(), STATE_DIR_VAR);
  if (!dir) {
    console.error(
      'No state directory: pass --state-dir <dir>, or set STATE_DIR in the environment or in .env.',
    );
    return 2;
  }

  console.log(`Importing ${dir} -> sente.db (lock: ${STATE_DIR_LOCK_FILE})`);
  const reports = await importStateToSqlite(dir, (line) => console.log(`  ${line}`));
  console.log('');
  for (const report of reports) {
    console.log(`${report.name}\n${describe(report)}\n`);
  }
  const bad = reports.filter((report) => !report.ok);
  if (bad.length > 0) {
    console.error(`${bad.length} store(s) did not verify: ${bad.map((r) => r.name).join(', ')}`);
    return 1;
  }
  console.log(
    `All ${reports.length} store(s) verified. The JSON files were not modified; ` +
      'start the API with STORE_BACKEND=sqlite, or leave it on file to roll back.',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
