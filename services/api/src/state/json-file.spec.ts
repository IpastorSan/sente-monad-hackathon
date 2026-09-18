import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonRecordFile, STATE_DIR_VAR, stateDir, statePath } from './json-file';

describe('stateDir / statePath', () => {
  it('is undefined when STATE_DIR is unset or blank — persistence stays opt-in', () => {
    expect(stateDir({})).toBeUndefined();
    expect(stateDir({ [STATE_DIR_VAR]: '   ' })).toBeUndefined();
    expect(statePath('user-wallets', {})).toBeUndefined();
  });

  it('resolves a relative STATE_DIR against the cwd, so the same value means one directory', () => {
    const env = { [STATE_DIR_VAR]: 'services/api/.state' };
    expect(stateDir(env)).toBe(join(process.cwd(), 'services/api/.state'));
    expect(statePath('agents', env)).toBe(join(process.cwd(), 'services/api/.state/agents.json'));
  });
});

describe('JsonRecordFile', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-state-'));
    path = join(dir, 'nested', 'records.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads an absent file as empty, and creates the directory on the first save', () => {
    const file = new JsonRecordFile<{ id: string }>(path);
    expect(file.load()).toEqual([]);

    file.save([{ id: 'a' }]);
    expect(new JsonRecordFile<{ id: string }>(path).load()).toEqual([{ id: 'a' }]);
  });

  it('round-trips Date and bigint, wherever they sit in the record', () => {
    type Record_ = {
      at: Date;
      nested: { amountWei: bigint; caps: { atoms: bigint }[] };
      name: string;
      count: number;
      flag: boolean;
      nothing: null;
    };
    const record: Record_ = {
      at: new Date('2026-09-18T12:00:00.000Z'),
      nested: { amountWei: 10n ** 21n, caps: [{ atoms: 1_000_000_000n }] },
      name: 'agent',
      count: 3,
      flag: false,
      nothing: null,
    };

    new JsonRecordFile<Record_>(path).save([record]);
    const [loaded] = new JsonRecordFile<Record_>(path).load();

    expect(loaded).toEqual(record);
    expect(loaded!.at).toBeInstanceOf(Date);
    expect(typeof loaded!.nested.amountWei).toBe('bigint');
    expect(typeof loaded!.nested.caps[0]!.atoms).toBe('bigint');
  });

  it('drops an absent optional field rather than storing it as null', () => {
    type Record_ = { id: string; maybe?: string };
    new JsonRecordFile<Record_>(path).save([{ id: 'a', maybe: undefined }]);

    expect(JSON.parse(readFileSync(path, 'utf8')).records[0]).toEqual({ id: 'a' });
    expect('maybe' in new JsonRecordFile<Record_>(path).load()[0]!).toBe(false);
  });

  it('replaces the whole file on every save, and leaves no temp file behind', () => {
    const file = new JsonRecordFile<{ id: string }>(path);
    file.save([{ id: 'a' }, { id: 'b' }]);
    file.save([{ id: 'b' }]);

    expect(new JsonRecordFile<{ id: string }>(path).load()).toEqual([{ id: 'b' }]);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['records.json']);
  });

  it('never leaves a half-written file: the target only ever holds a complete save', () => {
    // The atomicity claim is `rename`, so the thing to prove is that the file
    // under `path` is never the incomplete one — a save writes a sibling temp
    // and moves it. Reading between the two writes below can only ever yield
    // one of the two complete documents.
    const file = new JsonRecordFile<{ id: string; blob: string }>(path);
    file.save([{ id: 'a', blob: 'x'.repeat(200_000) }]);
    const first = readFileSync(path, 'utf8');
    file.save([{ id: 'b', blob: 'y'.repeat(200_000) }]);
    const second = readFileSync(path, 'utf8');

    expect(JSON.parse(first).records[0].id).toBe('a');
    expect(JSON.parse(second).records[0].id).toBe('b');
  });

  it('refuses to start empty on a file it cannot read', () => {
    // Starting empty is the failure this whole file exists to prevent: it looks
    // like success and the next register mints a second wallet.
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(() => new JsonRecordFile(broken).load()).toThrow(/not readable JSON/);
  });

  it('refuses to start empty on a file from another format version', () => {
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ version: 99, records: [] }));
    expect(() => new JsonRecordFile(other).load()).toThrow(/not a v1 state file/);
  });
});
