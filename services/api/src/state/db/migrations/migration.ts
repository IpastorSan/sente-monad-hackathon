/**
 * One schema migration (SEN-205). `id` is the position in the sequence (1, 2,
 * 3, …), `name` is recorded beside it in `schema_migrations` and checked on
 * every boot, so a migration that was edited after it ran fails loudly rather
 * than silently diverging from the database it ran on. `sql` may hold several
 * statements; the whole sequence runs inside one transaction.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}
