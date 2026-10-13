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

Converted so far: the agent store (`agents/store/sqlite-agent-store.ts`), the
user-wallet registry (`wallet/store/sqlite-user-wallet-registry.ts`) and the
watcher store (`agents/watchers/sqlite-watcher-store.ts`, `agent_watchers`,
migration 4).

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
   interface over a `SenteDb`: a `COLUMNS` list and a `row(record)` that fills
   it, the statements prepared in the constructor from `state/db/row.ts`
   (`insertSql`, `upsertSql`, `updateSql`; `toDataJson` / `fromRow` /
   `fromRows` for `data`), the file store's exact error messages, and two
   extras the import needs: `put(record)` (the upsert) and `listAll()`. Plus
   `path` and `size`, which `selectStore` logs at boot. Erasable syntax with
   `.ts` specifiers, like the file store, so the import script can load it
   under node's type stripping (`CLAUDE.md` gotcha 10). JSONL stores
   (append-only logs) get an `append`-shaped table; `put` is still an upsert on
   whatever key the log has.
3. **Switch** — in the module, inject `SenteDbLease` instead of `StateDirLease`
   and hand the three constructors to
   `selectStore<Interface>(lease, '<file>', '<noun>', { memory, file, sqlite })`
   (`agents/store/agent-store.module.ts`); it picks one and logs the
   persistent choice, so the module's own log line goes.
4. **Spec** — add the SQLite store as a third row of the existing
   `describe.each` behaviour table and a second row of the persistence table,
   built on `state/db/testing/opened-dbs.ts` (`dbs.reopen(dir)` is a restart)
   as `agents/store/file-agent-store.spec.ts` does. The file-only case (a
   directory that cannot be written) stays in its own `describe`.
5. **Import** — one entry in `STORE_IMPORTS` in `state/db/state-import.ts`:
   `{ name, file, load, open, key }`. `loadJsonRecords` covers `.json`
   envelope files; a `.jsonl` store brings its own `load`. Add the name to the
   "covers every converted store" assertion in `state-import.spec.ts`.
6. **Docs** — the "converted so far" line above and gotcha 14.

A store that two services write together is the reason `transaction` exists:
wrap the calls at the service, and each store's own transaction joins it.

Hiring, revoking and archiving have nothing to wrap (checked 2026-10-13):
`AgentsService` writes one store, the agent store, and its two writes in a
hire (`insert`, then `update` with the pin, the ERC-8004 id and the gas
outcome) sit on either side of Privy, the registry, the drip and Alchemy on
purpose — the record must be on disk before any of those runs, so a crash
mid-hire never loses a provisioned wallet (SEN-48). Revoke is the same shape
around the policy PATCH; archive is one write. Grouping them would mean holding
a transaction across network awaits, which `transaction` refuses.

## Cut-over and rollback

The import copies the files into the database and never modifies the files,
so the rollback is the same switch, flipped back.

Locally: `pnpm --filter @sente/api run state:import-sqlite [-- --state-dir <dir>]`
(the directory also comes from `STATE_DIR` in the environment or in `.env`).

The runtime image carries `dist/` only, so the same code is also compiled into
it: `src/state-import-sqlite.ts` → `node dist/state-import-sqlite.js
[--state-dir <dir>]`, which reads `STATE_DIR` from the environment. On the box
it runs as a one-off container of the `api` service — same image, same
`STATE_DIR`, same bind mount, same uid 1000, same `hostname: sente-api` the
lock records — so it needs nothing the deploy did not already ship.

### The production runbook

Every command from `infra/` on the laptop, with `PROJECT=plenary-anvil-491607-s6`
and `ZONE=europe-southwest1-a` exported, as for `deploy.sh`. The box is
`sente-eu`. Not yet run there; rehearsed locally (below).

```bash
box() { gcloud compute ssh sente-eu --project "$PROJECT" --zone "$ZONE" --command "$1"; }

# 0. The build that has the import and the SQLite stores, deployed as usual
#    with STORE_BACKEND unset or `file` in the repo .env. Nothing changes yet.
./deploy.sh

# 1. Stop the API (its shutdown releases api.lock), then back the files up.
box 'cd /opt/sente && sudo docker compose stop api'
box 'sudo tar czf ~/sente-state-pre-sqlite-$(date +%F-%H%M).tgz -C /var/lib/sente state && ls -l ~/sente-state-pre-sqlite-*.tgz'

# 2. The import. Takes the lock, copies, verifies, releases. Expect
#    "All N store(s) verified." and exit 0; on exit 1 stop here (the API is
#    still on `file`, so `box 'cd /opt/sente && sudo docker compose start api'`
#    is the whole rollback).
box 'cd /opt/sente && sudo docker compose run --rm --no-deps api node dist/state-import-sqlite.js'

# 3. Flip the switch: STORE_BACKEND=sqlite in the repo .env (BACKUP_INTERVAL_MINUTES
#    and BACKUP_KEEP too, if not the defaults), then deliver it.
DRY_RUN=1 ./push-secrets.sh
./push-secrets.sh

# 4. Start the API on the new api.env. --force-recreate: a stopped container
#    keeps the environment it was created with.
box 'cd /opt/sente && sudo docker compose up -d --force-recreate api'
box 'sleep 30; sudo docker logs --tail 80 sente-api 2>&1 | grep -E "StateDb|StateStore|StateDbBackup"'
#    Expect: "Opened /var/lib/sente/state/sente.db (schema vN)", one
#    "... in /var/lib/sente/state/sente.db" line per converted store with the
#    counts the import printed, and a first backup under .../backups/.

# 5. The usual post-deploy checks.
./live-check.sh --box
```

`docker compose run` gives the one-off container a generated name, so it does
not collide with `container_name: sente-api`, and `--no-deps` keeps it from
touching Caddy. A re-run of step 2 is safe at any point the API is stopped.

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

Rollback: `STORE_BACKEND=file` in the repo .env, `./push-secrets.sh`, then
`box 'cd /opt/sente && sudo docker compose up -d --force-recreate api'`. Anything
written under `sqlite` after the cut-over stays in `sente.db` and is not in the
files; to carry it back, there is no reverse import yet — restore the file
backup you took, or leave `sqlite` on and fix forward. A later `./deploy.sh`
keeps whichever value `api.env` has; it never resets the switch.

Rehearsed 2026-10-13, locally: `node dist/state-import-sqlite.js` from a
`nest build` against a seeded temp `STATE_DIR` (verified, idempotent on a
re-run, exit 2 with no directory, exit 1 on a held lock), then the compiled API
booted on it under `sqlite` and took its boot backup; and step 2 verbatim,
`docker compose run --rm --no-deps api node dist/state-import-sqlite.js`, in a
copy of `infra/docker-compose.yml` pointed at a local image built by the
Dockerfile, a scratch env file and a scratch state directory.

## Backups

`sente.db` under WAL is three files (`sente.db`, `sente.db-wal`,
`sente.db-shm`), and `cp` of the main file while the API runs can miss the WAL.
`SenteDb.backupTo(path)` — `VACUUM INTO` — gives one self-contained file
while the API keeps writing, and under `sqlite` the API takes one on its own
(`SenteDbBackups`, `state/state.module.ts`; `state/db/backups.ts`):

- right after boot (once the app is up, never holding the boot), then every
  `BACKUP_INTERVAL_MINUTES` (default 360; `0` turns them off, with a warning);
- to `<STATE_DIR>/backups/sente-<UTC yyyymmddThhmmssZ>.db`, keeping the newest
  `BACKUP_KEEP` (default 8, so two days at the default interval). Only files
  with that name are pruned; anything else in the directory is left alone;
- each one logged with its size and duration (`StateDbBackup`); a failure is
  logged and the next tick tries again. A malformed `BACKUP_*` value refuses
  the boot under `sqlite` (and is ignored under `file`).

They sit on the same disk as the database: they cover a bad write, migration or
deploy, not the disk. To take one off the box:

```bash
box 'sudo ls -l /var/lib/sente/state/backups'
box 'sudo cat /var/lib/sente/state/backups/sente-<stamp>.db' > sente-<stamp>.db
```

With the API stopped, the `tar` in `docs/deploy.md` "Rolling back" is fine too:
the shutdown checkpoint folded the WAL into the main file.

A backup restores by copying it to `<STATE_DIR>/sente.db` with the API stopped
and the `-wal` and `-shm` files removed, owned by uid 1000.
