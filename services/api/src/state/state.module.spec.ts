import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';

import { AGENT_STORE, InMemoryAgentStore } from '../agents/store/agent-store';
import { AgentStoreModule } from '../agents/store/agent-store.module';
import { FileAgentStore } from '../agents/store/file-agent-store';
import { SqliteAgentStore } from '../agents/store/sqlite-agent-store';
import { STATE_DIR_LOCK_FILE } from './state-dir-lock';
import { SenteDbLease, StateDirLease } from './state.module';
import { STORE_BACKEND_VAR } from './store-backend';

/**
 * The switch, wired: what `AgentStoreModule` hands out under each
 * `STORE_BACKEND`, with and without `STATE_DIR`, and that shutdown lets go of
 * the lock and the database.
 */
describe('StateModule', () => {
  let dir: string;
  const env = {
    STATE_DIR: process.env['STATE_DIR'],
    STORE_BACKEND: process.env[STORE_BACKEND_VAR],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-state-module-'));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(stateDir: string | undefined, backend: string | undefined) {
    if (stateDir === undefined) delete process.env['STATE_DIR'];
    else process.env['STATE_DIR'] = stateDir;
    if (backend === undefined) delete process.env[STORE_BACKEND_VAR];
    else process.env[STORE_BACKEND_VAR] = backend;
    const app = await Test.createTestingModule({ imports: [AgentStoreModule] }).compile();
    await app.init();
    return app;
  }

  it('keeps every store in memory without STATE_DIR, whatever the backend', async () => {
    const app = await boot(undefined, 'sqlite');
    expect(app.get(AGENT_STORE)).toBeInstanceOf(InMemoryAgentStore);
    expect(app.get(SenteDbLease).db).toBeUndefined();
    await app.close();
    expect(existsSync(join(dir, 'sente.db'))).toBe(false);
  });

  it('serves the file store by default under STATE_DIR — production as it was', async () => {
    const app = await boot(dir, undefined);
    expect(app.get(AGENT_STORE)).toBeInstanceOf(FileAgentStore);
    expect(app.get(SenteDbLease).backend).toBe('file');
    expect(app.get(SenteDbLease).db).toBeUndefined();
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(true);
    await app.close();
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(false);
    expect(existsSync(join(dir, 'sente.db'))).toBe(false);
  });

  it('serves the SQLite store under STORE_BACKEND=sqlite, and closes it with the lock', async () => {
    const app = await boot(dir, 'sqlite');
    expect(app.get(AGENT_STORE)).toBeInstanceOf(SqliteAgentStore);
    const lease = app.get(SenteDbLease);
    expect(lease.db?.path).toBe(join(dir, 'sente.db'));
    expect(lease.db?.schemaVersion).toBeGreaterThan(0);
    expect(lease.dir).toBe(app.get(StateDirLease).dir);
    await app.close();
    expect(existsSync(join(dir, STATE_DIR_LOCK_FILE))).toBe(false);
    expect(() => lease.db!.prepare('SELECT 1')).toThrow(/not open/);
  });

  it('refuses to boot on an unknown STORE_BACKEND, naming it', async () => {
    await expect(boot(dir, 'postgres')).rejects.toThrow(/STORE_BACKEND="postgres"/);
  });
});
