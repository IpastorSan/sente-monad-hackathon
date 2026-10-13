// What every SQLite store shares (SEN-205): the `data` column's codec and the
// INSERT / UPSERT statements derived from a column list, so a store declares
// its columns once and never hand-writes a placeholder or a conflict clause.
//
// Erasable syntax only (CLAUDE.md gotcha 10).

import { decodeValue, encodeValue, type JsonValue } from '../json-file.ts';

/** A whole record as the `data` column holds it: the files' tagged JSON. */
export function toDataJson(record: unknown): string {
  return JSON.stringify(encodeValue(record));
}

/** The record in a row's `data` column, or `undefined` for no row. */
export function fromRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  return row ? (decodeValue(JSON.parse(String(row['data'])) as JsonValue) as T) : undefined;
}

export function fromRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => fromRow<T>(row)!);
}

/** `INSERT INTO t (a, b) VALUES (?, ?)`. */
export function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

/** `insertSql` plus `ON CONFLICT (key) DO UPDATE SET` every other column. */
export function upsertSql(table: string, columns: readonly string[], key: string): string {
  const updates = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  return `${insertSql(table, columns)} ON CONFLICT (${key}) DO UPDATE SET ${updates}`;
}

/** `UPDATE t SET a = ?, b = ? WHERE key = ?`, for the columns after the key. */
export function updateSql(table: string, columns: readonly string[], key: string): string {
  const sets = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = ?`)
    .join(', ');
  return `UPDATE ${table} SET ${sets} WHERE ${key} = ?`;
}
