# The API's state: JSON files and `sente.db`

What `STATE_DIR` holds, which backend reads it, how a store is added to SQLite,
and how the cut-over and its rollback go. Written 2026-10-13 with SEN-205, which
converted every store; production cut over to `sqlite` the same day (the
runbook below, as run).

## The two backends

With `STATE_DIR` set (`CLAUDE.md` gotcha 14), every store persists there; unset,
every store is in memory and nothing below applies. `STORE_BACKEND` picks how:

| `STORE_BACKEND`      | Reads and writes                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `file` (the default) | One JSON or JSONL file per store, `services/api/src/state/json-file.ts`. What production ran until the 2026-10-13 cut-over. |
| `sqlite`             | `<STATE_DIR>/sente.db` for every store (all twelve are converted). What production runs since 2026-10-13.                   |

Anything else refuses to boot, naming the value (`state/store-backend.ts`): a
typo that fell back to `file` would look like a working API reading the wrong
store. The switch is read once, at boot, by `SenteDbLease`
(`state/state.module.ts`), which opens the database only after `StateDirLease`
holds `api.lock` — the same single-writer rule as the files, enforced the same
way — runs the migrations, checkpoints the WAL on shutdown, and closes the
database only when the process exits, so an agent run still in flight after
the HTTP server stops can finish writing its transcript and events.

Converted so far: the agent store (`agents/store/sqlite-agent-store.ts`), the
user-wallet registry (`wallet/store/sqlite-user-wallet-registry.ts`); in
migration 2, the profiles (`profile/sqlite-profile.store.ts`), the starter kits
(`starter-kit/sqlite-starter-kit.store.ts`), the creator fee ledger
(`fees/sqlite-creator-fees.ts`, which `creator:payout` also opens under
`sqlite`), and the three stores sealed under `AGENT_SECRETS_KEY`: the credit
keys (`credits/store/sqlite-credit-key-store.ts`), the agent secrets
(`agents/venues/sqlite-agent-secret-store.ts`) and the user venue secrets
(`trade/sqlite-user-venue-secrets.ts`); and, in migration 3, the three
append-only logs: the agent event log
(`agents/events/sqlite-agent-event-log.ts`), run transcripts
(`agents/runner/transcript/sqlite-run-transcript-store.ts`) and the value
history (`portfolio/history/sqlite-value-history-store.ts`); and, in
migration 4, the watcher store (`agents/watchers/sqlite-watcher-store.ts`).

The sealed stores keep a two-layer shape: `state/db/record-table.ts` moves the
file's sealed records in and out of the table as they are (that is all the
import touches, so it never needs the key), and the store on top seals,
decrypts every row once at boot (a wrong key still fails the boot) and unseals
per read instead of caching plaintext in memory.

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

### The append-only logs

`agent-events.jsonl`, `agent-runs.jsonl` and `value-history.jsonl` become
`agent_events` (+ `agent_event_truncation`), `agent_runs` + `agent_run_entries`
and `value_history` (`migrations/003-append-logs.ts`). Their `data` is the
line's payload as plain JSON, as in the files, not the tagged JSON of the
record stores: everything in them is JSON-safe before it is stored.

- **Event log.** `seq` is the table's AUTOINCREMENT key, so it carries on
  across restarts and the import (which keeps the file's numbers) and is never
  reused. `list` keeps the exact paging (`afterSeq` + `limit` takes the first
  page after the cursor, `limit` alone the last page) through
  `(agent_id, seq)`, `(agent_id, kind, seq)` and `(agent_id, run_id, seq)`.
  The per-agent cap deletes the oldest rows as each append lands and adds them
  to `agent_event_truncation`, so `truncation` survives a restart without the
  file's compaction header. An agent's whole history, once read, is cached in
  memory and kept current by `append`: the resting-fill watcher reads every
  agent's history every 15 s, and at the 10k cap an uncached read parses 10k
  rows (~25 ms). Filtered reads always query.
- **Run transcripts.** Still the in-memory store serving every read (the runner
  records synchronously and a live run is streamed by cursor); the tables are
  the journal it reads back at boot. A run the cap evicts is deleted with its
  entries at once. Every entry is now a durable commit, where the file was not
  fsynced.
- **Value history.** Queried per call. `(kind, subject_id, at, dup)` is unique
  and is also the order: `dup` numbers a subject's snapshots at the same
  millisecond in arrival order, which is the file store's tie order. The cap
  is applied on append.

A failed write is logged and the caller carries on, as with the files: an
event or a transcript line records something that already happened.

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
   extras the import needs: `put(record)` (a write by key; the import calls it
   only for keys the table does not hold) and `listAll()`. Plus
   `path` and `size`, which `selectStore` logs at boot. Erasable syntax with
   `.ts` specifiers, like the file store, so the import script can load it
   under node's type stripping (`CLAUDE.md` gotcha 10). JSONL stores
   (append-only logs) get an `append`-shaped table; `put` still writes by
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
   envelope files; a `.jsonl` store brings its own `load`, streamed with
   `state/jsonl.ts#readJsonlLines` and applying the file store's own line
   checks and caps, and sets `ordered: true` so the check also proves the
   table reads back in the file's order. Add the name to the "covers every
   converted store" assertion in `state-import.spec.ts`.
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
`STATE_DIR`, same bind mount, same uid 1000 — so it needs nothing the deploy did
not already ship.

That one-off container also has the API's `hostname: sente-api` and runs node
as pid 1, which is exactly what the lock reads as "a previous incarnation of
this container" (`state/state-dir-lock.ts`): it would take over the lock of an
API that is still running. `docker compose run` has no `--hostname` to tell
them apart (Compose 5.5), so step 2 refuses to start unless `docker compose ps`
shows no running `api` — the lock cannot protect this one case, the check does.

### The production runbook

Every command from `infra/` on the laptop, with `PROJECT=plenary-anvil-491607-s6`
and `ZONE=europe-southwest1-a` exported, as for `deploy.sh`. The box is
`sente-eu`. Run there on 2026-10-13 at 12:48 UTC: 12 of 12 stores verified by
the import, the live check passed, and the pre-cut-over tarball is in `~` on
the box. Rehearsed locally first (below).

```bash
box() { gcloud compute ssh sente-eu --project "$PROJECT" --zone "$ZONE" --command "$1"; }

# 0. The build that has the import and the SQLite stores, deployed as usual
#    with STORE_BACKEND unset or `file` in the repo .env. Nothing changes yet.
./deploy.sh

# 1. Stop the API (its shutdown releases api.lock), then back the files up.
box 'cd /opt/sente && sudo docker compose stop api'
box 'sudo tar czf ~/sente-state-pre-sqlite-$(date +%F-%H%M).tgz -C /var/lib/sente state && ls -l ~/sente-state-pre-sqlite-*.tgz'

# 2. The import, ONCE, against a fresh sente.db (there is none before this
#    step). Refuses unless the API is stopped (see above); then takes the lock,
#    copies, verifies, releases. Expect "All N store(s) verified." and exit 0;
#    on exit 1 stop here (the API is still on `file`, so
#    `box 'cd /opt/sente && sudo docker compose start api'` is the whole rollback).
box 'cd /opt/sente && test -z "$(sudo docker compose ps -q --status running api)" && sudo docker compose run --rm --no-deps api node dist/state-import-sqlite.js'

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
touching Caddy.

Run the import once, against a fresh `sente.db`. To redo it (a failed step 2,
a change of plan before step 4), stop the API and move `sente.db`,
`sente.db-wal` and `sente.db-shm` aside first, then run step 2 again. A re-run
over a database the API has written is not destructive — it never overwrites a
row — but it cannot tell a row the API deleted (an evicted run or snapshot)
from one never imported, and adds those back.

What the script does: takes `api.lock` (it refuses while another live process
holds the directory — except the one-off container case above), opens or
creates `sente.db` and migrates it, and for each store in `STORE_IMPORTS` loads
the file as the file store would (a bad file fails, it does not import empty),
inserts, in one transaction, every record whose key the table does not hold
yet, reads the table back and compares it with the file record by record. It
is insert-only: a re-run only adds what is missing; it never overwrites a row
the API wrote. It prints, per store, the file's and the table's record counts
and content hashes (sha256 over the records' canonical tagged JSON), how many
it wrote, how many are identical, how many the API has changed since
(`changedSince`, left as the API wrote them) and how many the table holds that
the file does not (records the API wrote under `sqlite` since the copy). It
exits 1 if any file record is missing from its table, or, for a log, reads
back out of the file's order.

The logs are loaded as their file stores would load them at boot, without
touching the files: the same per-agent and per-subject caps (what the event
cap drops is carried into `agent_event_truncation`), a torn last line skipped
and left in place, a corrupt line elsewhere refused. A log record is keyed by
what identifies it (an event's `seq`; a run's id and an entry's `seq`; a
snapshot's subject, `at` and `dup`), so a re-run skips what is already there.
One edge: an event the cap evicted under `sqlite` since the first copy is not
resurrected by a re-run, and the re-run reports it missing. Measured on a
laptop: 300k events and 400k snapshots import and verify in about 7 s.

Rollback: `STORE_BACKEND=file` in the repo .env, `./push-secrets.sh`, then
`box 'cd /opt/sente && sudo docker compose up -d --force-recreate api'`. It is
safe only before the first user write under `sqlite`. Anything written after
the cut-over stays in `sente.db` and is not in the files, and there is no
reverse import. That includes wallet bindings: a user who registered under
`sqlite` has no binding in `user-wallets.json`, so after a rollback their next
`POST /wallet/register` mints a second Privy wallet and the first one's funds
stop being reachable from the product (SEN-48). Once users have written,
leave `sqlite` on and fix forward. A later `./deploy.sh` keeps whichever value
`api.env` has; it never resets the switch.

The other way round, booting under `sqlite` before the import has run refuses:
`SenteDbLease` will not serve an empty `user_wallets` table beside a
`user-wallets.json` that holds bindings, and names the import.

`privy:recover --apply` and `creator:payout` write the same stores outside the
API. They read `STORE_BACKEND` like `STATE_DIR` (environment, else the env
file) and exit 2 when it does not match the directory: `file` beside a
`sente.db`, or `sqlite` without one.

Rehearsed 2026-10-13, locally: `node dist/state-import-sqlite.js` from a
`nest build` against a seeded temp `STATE_DIR` (verified, idempotent on a
re-run, exit 2 with no directory, exit 1 on a held lock), then the compiled API
booted on it under `sqlite` and took its boot backup; and step 2's import
command, `docker compose run --rm --no-deps api node dist/state-import-sqlite.js`
(before the `docker compose ps` guard was added in front of it), in a
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
