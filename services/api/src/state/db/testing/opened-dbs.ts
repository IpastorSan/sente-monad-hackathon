import { SenteDb, senteDbPath } from '../sente-db';

/**
 * The databases a spec opens, closed together in `afterEach`, and "a restart":
 * close everything, then open `<dir>/sente.db` again.
 *
 *   const dbs = openedDbs();
 *   afterEach(() => dbs.closeAll());
 *   const store = () => new SqliteAgentStore(dbs.reopen(dir));
 */
export function openedDbs() {
  const open: SenteDb[] = [];
  const track = (db: SenteDb): SenteDb => {
    open.push(db);
    return db;
  };
  return {
    /** Open `path` (a file, or `IN_MEMORY`) and track it. */
    open: (path: string): SenteDb => track(SenteDb.open(path)),
    /** Close every open database, then open `<dir>/sente.db` as a new process would. */
    reopen: (dir: string): SenteDb => {
      closeAll();
      return track(SenteDb.open(senteDbPath(dir)));
    },
    /** The database opened last, for a spec that wants to query the table directly. */
    get last(): SenteDb | undefined {
      return open.at(-1);
    },
    closeAll,
  };
  function closeAll(): void {
    for (const db of open.splice(0)) db.close();
  }
}
