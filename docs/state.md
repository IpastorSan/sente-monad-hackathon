# The API's state: JSON files and `sente.db`

What `STATE_DIR` holds, which backend reads it, how a store is added to SQLite,
and how the cut-over and its rollback go. Written 2026-10-13 with SEN-205, the
first phase: the foundation plus two stores. The rest of the stores follow the
same pattern and are converted in later issues.

## The two backends

With `STATE_DIR` set (`CLAUDE.md` gotcha 14), every store persists there; unset,
every store is in memory and nothing below applies. `STORE_BACKEND` picks how:

| `STORE_BACKEND`      | Reads and writes                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file` (the default) | One JSON or JSONL file per store, `services/api/src/state/json-file.ts`. What production ran before SEN-205 and what it keeps running until the switch flips. |
| `sqlite`             | `<STATE_DIR>/sente.db` for every store that has a SQLite implementation. A store not converted yet keeps its file, under either value.                        |

Anything else refuses to boot, naming the value (`state/store-backend.ts`): a
typo that fell back to `file` would look like a working API reading the wrong
store. The switch is read once, at boot, by `SenteDbLease`
(`state/state.module.ts`), which opens the database only after `StateDirLease`
holds `api.lock` — the same single-writer rule as the files, enforced the same
way — runs the migrations, and closes the database with a WAL checkpoint on
shutdown.

Converted so far: the agent store (`agents/store/sqlite-agent-store.ts`) and the
user-wallet registry (`wallet/store/sqlite-user-wallet-registry.ts`).

## The database

`node:sqlite` (`DatabaseSync`), no native module; Node 26.10 ships SQLite 3.53.
`state/db/sente-db.ts` wraps the one connection:

- `journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`,
  `busy_timeout = 5000`. FULL rather than NORMAL because the records here are
  the ones whose loss mints a second Privy wallet (SEN-48): the file stores
  fsync every write today, and at tens of writes an hour the extra fsync per
  commit is free. The header of `sente-db.ts` has the reasoning for each.
- `transaction(fn)`: `BEGIN IMMEDIATE … COMMIT`, rollback on a throw. A nested
  call joins the outer transaction through a savepoint, so a service that
  writes two stores can wrap both in one `transaction` and they land or vanish
  together. `fn` must be synchronous; a Promise returned from it is refused.
- `backupTo(path)`: `VACUUM INTO`, a consistent copy while the API keeps
  writing. `checkpoint()`, `close()`.

### Schema

One table per store, pragmatic and query-friendly: a real column for the key
and for every field the store looks records up by (ids, the owner's user id,
addresses, status, timestamps as ISO 8601 UTC), plus `data TEXT` holding the
whole record as the same tagged JSON the files use (`{"$date":…}`,
`{"$bigint":…}`, `state/json-file.ts#encodeValue`). The columns serve `WHERE`
and `ORDER BY`; `data` is the record of truth, so a parsed mandate's bigint
atoms and every `Date` come back exactly, the store interfaces do not change,
and a field added to a record type persists with no schema change. A sealed
secret stays sealed: its ciphertext goes into `data` as it was in the file.

Tables are `STRICT`. Sort by `created_at, rowid` to reproduce the files'
"oldest first, insertion order on a tie".

### Migrations

`state/db/migrations/`: one module per migration exporting
`{ id, name, sql }`, listed in order in `migrations/index.ts`. `SenteDb.open`
applies the ones not recorded in `schema_migrations`, in one transaction, at
boot. A recorded migration whose `name` changed fails the boot, as does a
database written by a newer build (a recorded id the code does not have).
**Never edit a migration that has run anywhere**; a fix is a new migration.
`sente-db.spec.ts` applies the whole registry to a fresh in-memory database.

## Adding a store

Copy the agent store. Six places, each with a worked example in the tree:

1. **Migration** — `state/db/migrations/NNN-<store>.ts`, next integer id, one
   table (`001-agents-and-user-wallets.ts`), appended to `MIGRATIONS` in
   `migrations/index.ts`.
2. **Store** — `<module>/store/sqlite-<store>.ts` implementing the existing
   interface over a `SenteDb`: prepare the statements in the constructor, keep
   the file store's exact error messages, `data` through `encodeValue` /
   `decodeValue`, and two extras the import needs: `put(record)` (an upsert by
   key) and `listAll()`. Plus `path` and `size` for the boot log. Erasable
   syntax with `.ts` specifiers, like the file store, so the import script can
   load it under node's type stripping (`CLAUDE.md` gotcha 10). JSONL stores
   (append-only logs) get an `append`-shaped table; `put` is still an upsert on
   whatever key the log has.
3. **Switch** — in the module, inject `SenteDbLease` instead of `StateDirLease`
   and wrap the three constructors in `selectStore<Interface>(lease, '<file>',
{ memory, file, sqlite })` (`agents/store/agent-store.module.ts`). The
   `file` branch is what the provider did before; keep its log line.
4. **Spec** — add the SQLite store as a third row of the existing
   `describe.each` behaviour table and a second row of the persistence table,
   with a `reopen()` that closes and reopens the database
   (`agents/store/file-agent-store.spec.ts`). The file-only case (a directory
   that cannot be written) stays in its own `describe`.
5. **Import** — one entry in `STORE_IMPORTS` in `state/db/state-import.ts`:
   `{ name, file, load, open, key }`. `loadJsonRecords` covers `.json`
   envelope files; a `.jsonl` store brings its own `load`. Add the name to the
   "covers every converted store" assertion in `state-import.spec.ts`.
6. **Docs** — the "converted so far" line above and gotcha 14.

A store that two services write together is the reason `transaction` exists:
wrap the calls at the service, and each store's own transaction joins it.

## Cut-over and rollback

The import copies the files into the database and never modifies the files,
so the rollback is the same switch, flipped back.

Locally: `pnpm --filter @sente/api run state:import-sqlite [-- --state-dir <dir>]`
(the directory also comes from `STATE_DIR` in the environment or in `.env`).

On the box the runtime image carries `dist/` only, no `scripts/` or `src/`, so
the script runs from the Dockerfile's `build` stage, which has the whole tree,
as the same uid that owns the state directory. Not yet run there — the
procedure as planned, to be checked against the box on the first cut-over:

```bash
# With the API stopped and a backup of /var/lib/sente/state taken first
# (docs/deploy.md, "Rolling back").
sudo docker compose -f /opt/sente/docker-compose.yml stop api
sudo docker build --target build -t sente-api-build -f services/api/Dockerfile .
sudo docker run --rm --user 1000:1000 -v /var/lib/sente/state:/var/lib/sente/state \
  -w /app/services/api sente-api-build \
  node --conditions=source --no-warnings=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/state-import-sqlite.ts --state-dir /var/lib/sente/state
# "All N store(s) verified." — then STORE_BACKEND=sqlite in the local .env,
# infra/push-secrets.sh (the allowlist carries it), and start the API again.
```

What the script does: takes `api.lock` (it refuses while the API or anything
else holds the directory), opens or creates `sente.db` and migrates it, and for
each store in `STORE_IMPORTS` loads the file as the file store would (a bad
file fails, it does not import empty), upserts every record in one
transaction, reads the table back and compares it with the file record by
record. It prints, per store, the file's and the table's record counts and
content hashes (sha256 over the records' canonical tagged JSON), how many are
identical, and how many the table holds that the file does not — records the
API wrote under `sqlite` since the copy, which is why a re-run is safe and
changes nothing. It exits 1 if any file record is missing from or differs in
its table.

Rollback: `STORE_BACKEND=file`, restart. Anything written under `sqlite` after
the cut-over stays in `sente.db` and is not in the files; to carry it back,
there is no reverse import yet — restore the file backup you took, or leave
`sqlite` on and fix forward.

## Backups

`sente.db` under WAL is three files (`sente.db`, `sente.db-wal`,
`sente.db-shm`), and `cp` of the main file while the API runs can miss the WAL.
Two correct ways:

- while the API runs: `SenteDb.backupTo(path)` — `VACUUM INTO` — gives one
  self-contained file. A periodic backup through it is a follow-up; until then
  `sqlite3 /var/lib/sente/state/sente.db "VACUUM INTO '/root/sente-$(date +%F).db'"`
  from the host does the same;
- with the API stopped: the `tar` in `docs/deploy.md` "Rolling back" is fine,
  the shutdown checkpoint folded the WAL into the main file.

A backup restores by copying it to `<STATE_DIR>/sente.db` with the API stopped
and the `-wal` and `-shm` files removed.
