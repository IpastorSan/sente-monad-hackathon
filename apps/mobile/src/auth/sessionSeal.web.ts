/**
 * Web twin of `sessionSeal.ts`: a signed-in tab survives a reload (SEN-176).
 *
 * `./sessionSealCore` does the sealing; this file supplies the browser's
 * pieces: `sessionStorage` for the ciphertext (dies with the tab), IndexedDB
 * for the non-extractable AES key, and WebCrypto. See `docs/web.md`, "Staying
 * signed in across a reload", for the trade-off this makes.
 *
 * Every function here swallows its own failures into "nothing sealed": a
 * browser with storage disabled signs in exactly as before, it just prompts
 * again after a reload.
 */
import {
  createSessionSeal,
  type KeyStore,
  type SealedSession,
  type SessionSeal,
} from './sessionSealCore';

export type { SealedSession };

const DB_NAME = 'sente-session-seal';
const STORE = 'keys';

type StoredKey = { key: CryptoKey; expiresAt: number };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return request(use(db.transaction(STORE, mode).objectStore(STORE)));
}

/**
 * Keys in IndexedDB, one per sealed tab. A key outlives its tab (IndexedDB is
 * per origin, not per tab) but is useless without the tab's ciphertext; the
 * expired ones are deleted the next time any tab seals.
 */
const indexedDbKeys: KeyStore = {
  async put(id, key, expiresAt) {
    await pruneExpired();
    await withStore('readwrite', (store) => store.put({ key, expiresAt } satisfies StoredKey, id));
  },
  async get(id) {
    const stored = (await withStore('readonly', (store) => store.get(id))) as StoredKey | undefined;
    return stored?.key;
  },
  async delete(id) {
    await withStore('readwrite', (store) => store.delete(id));
  },
};

/** One cursor walk in one transaction, deleting what has expired. */
async function pruneExpired(): Promise<void> {
  const db = await openDatabase();
  const cursor = db.transaction(STORE, 'readwrite').objectStore(STORE).openCursor();
  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    cursor.onerror = () => reject(cursor.error ?? new Error('IndexedDB cursor failed'));
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (at === null) return resolve();
      if (((at.value as StoredKey | undefined)?.expiresAt ?? 0) <= now) at.delete();
      at.continue();
    };
  });
}

let seal: SessionSeal | null | undefined;

/** `null` where the browser lacks a piece (no IndexedDB, no WebCrypto, no sessionStorage). */
function sessionSeal(): SessionSeal | null {
  if (seal !== undefined) return seal;
  try {
    const subtle = globalThis.crypto?.subtle;
    const storage = globalThis.sessionStorage;
    if (subtle === undefined || storage === undefined || globalThis.indexedDB === undefined) {
      seal = null;
    } else {
      seal = createSessionSeal({
        storage,
        keys: indexedDbKeys,
        subtle,
        randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
        now: () => Date.now(),
      });
    }
  } catch {
    // Reading `sessionStorage` throws when the browser blocks storage.
    seal = null;
  }
  return seal;
}

export async function sealSession(session: SealedSession): Promise<void> {
  await sessionSeal()
    ?.seal(session)
    .catch(() => undefined);
}

export async function unsealSession(): Promise<SealedSession | null> {
  return (
    (await sessionSeal()
      ?.unseal()
      .catch(() => null)) ?? null
  );
}

export async function sealApiToken(
  address: string,
  token: string,
  expiresAt: string | number,
): Promise<void> {
  await sessionSeal()
    ?.sealToken(address, token, expiresAt)
    .catch(() => undefined);
}

export async function unsealApiToken(address: string): Promise<string | null> {
  return (
    (await sessionSeal()
      ?.unsealToken(address)
      .catch(() => null)) ?? null
  );
}

export async function clearSealedSession(): Promise<void> {
  await sessionSeal()
    ?.clear()
    .catch(() => undefined);
}
