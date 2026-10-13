// The import's command line (SEN-205), shared by its two entries:
//
//   scripts/state-import-sqlite.ts   local, under node's type stripping
//                                    (`pnpm --filter @sente/api run state:import-sqlite`)
//   src/state-import-sqlite.ts       compiled to dist/, so it runs in the
//                                    runtime image, which has no scripts/ or src/
//
// The directory comes from `--state-dir`, else `STATE_DIR` in the environment,
// else `fallbackDir()` (the local script reads the repo-root .env). Nothing is
// printed but paths, counts and hashes. Returns the exit code: 0 verified,
// 1 a store did not verify (or the import threw), 2 no directory.
//
// Erasable syntax and `.ts` specifiers (CLAUDE.md gotcha 10).

import { STATE_DIR_VAR } from '../json-file.ts';
import { STATE_DIR_LOCK_FILE } from '../state-dir-lock.ts';
import { importStateToSqlite, type StoreImportReport } from './state-import.ts';

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
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

export async function runStateImport(
  args: readonly string[],
  fallbackDir: () => string | undefined = () => undefined,
): Promise<number> {
  try {
    const dir = flag(args, 'state-dir') ?? (process.env[STATE_DIR_VAR]?.trim() || fallbackDir());
    if (!dir) {
      console.error(
        'No state directory: pass --state-dir <dir>, or set STATE_DIR in the environment or in .env.',
      );
      return 2;
    }

    console.log(`Importing ${dir} -> sente.db (lock: ${STATE_DIR_LOCK_FILE})`);
    const reports = await importStateToSqlite(dir, (line) => console.log(`  ${line}`));
    console.log('');
    for (const report of reports) console.log(`${report.name}\n${describe(report)}\n`);
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}
