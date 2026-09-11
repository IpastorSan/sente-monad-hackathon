// Minimal `.env` read/upsert for the Privy scripts. Values go into the file and
// never to stdout: every function here returns variable NAMES only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The repo-root `.env`, as seen from services/api/scripts. */
export const DEFAULT_ENV_FILE = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../../.env',
);

/** `--env-file <path>` from argv, or the repo-root default. */
export function envFileFromArgs(argv: readonly string[] = process.argv): string {
  const index = argv.indexOf('--env-file');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error('--env-file needs a path');
  return value ? resolve(value) : DEFAULT_ENV_FILE;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Names whose value in `path` is non-empty. */
export function presentNames(path: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(path)) return names;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = LINE.exec(line);
    if (match && match[2]!.trim().replace(/^["']|["']$/g, '') !== '') names.add(match[1]!);
  }
  return names;
}

/**
 * Set `entries` in the env file. An existing NON-EMPTY value is kept unless
 * `overwrite` — replacing an authorization key orphans every wallet or policy
 * it owns, so that must be a deliberate act. An existing empty `NAME=` line is
 * filled in place; anything else is appended. A new file is created 0600.
 */
export function upsertEnv(
  path: string,
  entries: Readonly<Record<string, string>>,
  options: { overwrite?: boolean } = {},
): { written: string[]; kept: string[] } {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const present = presentNames(path);
  const written: string[] = [];
  const kept: string[] = [];

  for (const [name, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) throw new Error(`${name}: value spans lines`);
    if (present.has(name) && !options.overwrite) {
      kept.push(name);
      continue;
    }
    const index = lines.findIndex((line) => LINE.exec(line)?.[1] === name);
    if (index >= 0) lines[index] = `${name}=${value}`;
    else {
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${name}=${value}`, '');
    }
    written.push(name);
  }

  if (written.length > 0) writeFileSync(path, lines.join('\n'), { mode: 0o600 });
  return { written, kept };
}
