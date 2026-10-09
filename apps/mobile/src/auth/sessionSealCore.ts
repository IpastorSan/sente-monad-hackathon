/**
 * Sealing a signed-in session so a browser reload does not need a passkey
 * prompt (SEN-176). Web only: `sessionSeal.web.ts` wires this to the browser,
 * `sessionSeal.ts` is the native no-op.
 *
 * What is sealed is the minimum `openWalletSession` needs to rebuild the
 * session without a ceremony: the secp256k1 key for the session's one BIP-44
 * index and the `device` PRF output. Not the passkey, and not the `wallet` PRF
 * output, which would derive every index rather than the one in use.
 *
 * How:
 *
 * - AES-256-GCM under a key made by `generateKey({ extractable: false })`. The
 *   key lives in IndexedDB as a `CryptoKey`; script on the page can ask
 *   WebCrypto to use it, but nothing can read its bytes out.
 * - The ciphertext, IV and expiry (8 h) go to `sessionStorage`, which the
 *   browser drops when the tab closes. The key alone decrypts nothing.
 * - The record's header (key id, expiry, credential, account index, address)
 *   is the AES-GCM additional data, so editing any of it fails decryption.
 * - Any failure — absent, expired, edited, missing key, wrong length — clears
 *   both halves and reads as "not signed in". There is no partial restore.
 *
 * The API session token is sealed with the same key (see `sealToken`), so
 * nothing in `sessionStorage` is plaintext.
 *
 * Every dependency is injected, so `sessionSeal.test.ts` runs this under node
 * with node's WebCrypto and an in-memory key store.
 */
import { base64 } from '@scure/base';

import type { StoredCredential } from './ceremony.ts';
import { zeroize } from './derive.ts';

/** How long a sealed session survives without a passkey prompt. */
export const SEAL_TTL_MS = 8 * 60 * 60 * 1000;

const SESSION_KEY = 'sente.session.seal.v1';
const TOKEN_KEY = 'sente.session.token.v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The subset of `Storage` this needs. */
export type SealStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Where the non-extractable wrapping keys live (IndexedDB on web). */
export type KeyStore = {
  put(id: string, key: CryptoKey, expiresAt: number): Promise<void>;
  get(id: string): Promise<CryptoKey | undefined>;
  delete(id: string): Promise<void>;
};

export type SealDeps = {
  storage: SealStorage;
  keys: KeyStore;
  subtle: SubtleCrypto;
  randomBytes: (length: number) => Uint8Array<ArrayBuffer>;
  now: () => number;
};

/** What goes in, and what comes back out, of a seal. */
export type SealedSession = {
  readonly credential: StoredCredential;
  readonly accountIndex: number;
  /** EIP-55 address the session derived; checked again after rebuilding. */
  readonly address: string;
  /** secp256k1 key for `accountIndex`. The caller zeroes it after use. */
  readonly privateKey: Uint8Array;
  /** PRF output for the `device` salt. The caller zeroes it after use. */
  readonly devicePrfOutput: Uint8Array;
};

type SessionHeader = {
  v: 1;
  keyId: string;
  expiresAt: number;
  credentialId: string;
  transports: string[] | null;
  accountIndex: number;
  address: string;
};

type TokenHeader = { v: 1; keyId: string; expiresAt: number; address: string };

type Envelope<H> = H & { iv: string; ct: string };

export type SessionSeal = {
  /** Seals a fresh session, replacing (and destroying the key of) any previous one. */
  seal(session: SealedSession): Promise<void>;
  /** The sealed session, or `null` (and everything cleared) when there is none usable. */
  unseal(): Promise<SealedSession | null>;
  /** Seals the API token under the current session's key. No-op without a session. */
  sealToken(address: string, token: string, expiresAt: string | number): Promise<void>;
  /** The sealed API token for `address`, or `null`. */
  unsealToken(address: string): Promise<string | null>;
  /** Removes both records and destroys the key. */
  clear(): Promise<void>;
};

export function createSessionSeal(deps: SealDeps): SessionSeal {
  const { storage, keys, subtle, randomBytes, now } = deps;

  const readJson = (name: string): Record<string, unknown> | null => {
    try {
      const raw = storage.getItem(name);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const remove = (name: string): void => {
    try {
      storage.removeItem(name);
    } catch {
      // Storage disabled: nothing to remove either.
    }
  };

  async function clear(): Promise<void> {
    const keyId = readJson(SESSION_KEY)?.keyId;
    remove(SESSION_KEY);
    remove(TOKEN_KEY);
    if (typeof keyId === 'string') await keys.delete(keyId).catch(() => undefined);
  }

  async function encrypt(key: CryptoKey, header: object, plaintext: Uint8Array) {
    const iv = randomBytes(IV_BYTES);
    const ct = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(header) },
        key,
        plaintext as Uint8Array<ArrayBuffer>,
      ),
    );
    return { iv: base64.encode(iv), ct: base64.encode(ct) };
  }

  async function decrypt(key: CryptoKey, header: object, iv: string, ct: string) {
    return new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(iv), additionalData: aad(header) },
        key,
        bytes(ct),
      ),
    );
  }

  async function seal(session: SealedSession): Promise<void> {
    await clear();
    const keyId = base64.encode(randomBytes(16));
    const expiresAt = now() + SEAL_TTL_MS;
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await keys.put(keyId, key, expiresAt);
    const header: SessionHeader = {
      v: 1,
      keyId,
      expiresAt,
      credentialId: session.credential.credentialId,
      transports: session.credential.transports ? [...session.credential.transports] : null,
      accountIndex: session.accountIndex,
      address: session.address,
    };
    const plaintext = new Uint8Array(KEY_BYTES * 2);
    try {
      plaintext.set(session.privateKey, 0);
      plaintext.set(session.devicePrfOutput, KEY_BYTES);
      const envelope: Envelope<SessionHeader> = {
        ...header,
        ...(await encrypt(key, header, plaintext)),
      };
      storage.setItem(SESSION_KEY, JSON.stringify(envelope));
    } catch (error) {
      await clear();
      await keys.delete(keyId).catch(() => undefined);
      throw error;
    } finally {
      zeroize(plaintext);
    }
  }

  async function unseal(): Promise<SealedSession | null> {
    const record = readJson(SESSION_KEY);
    if (record === null) return null;
    const header = sessionHeader(record);
    if (
      header === null ||
      typeof record.iv !== 'string' ||
      typeof record.ct !== 'string' ||
      now() >= header.expiresAt
    ) {
      await clear();
      return null;
    }
    let plaintext: Uint8Array | undefined;
    try {
      const key = await keys.get(header.keyId);
      if (key === undefined) throw new Error('sealing key is gone');
      plaintext = await decrypt(key, header, record.iv, record.ct);
      if (plaintext.length !== KEY_BYTES * 2) throw new Error('sealed session has the wrong size');
      return {
        credential: {
          credentialId: header.credentialId,
          ...(header.transports !== null ? { transports: header.transports } : {}),
        },
        accountIndex: header.accountIndex,
        address: header.address,
        privateKey: plaintext.slice(0, KEY_BYTES),
        devicePrfOutput: plaintext.slice(KEY_BYTES),
      };
    } catch {
      await clear();
      return null;
    } finally {
      zeroize(plaintext);
    }
  }

  async function sealToken(
    address: string,
    token: string,
    expiresAt: string | number,
  ): Promise<void> {
    const session = sessionHeader(readJson(SESSION_KEY));
    if (session === null || !sameAddress(session.address, address)) return;
    const key = await keys.get(session.keyId);
    if (key === undefined) return;
    const tokenExpiry = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    const header: TokenHeader = {
      v: 1,
      keyId: session.keyId,
      expiresAt: Number.isFinite(tokenExpiry)
        ? Math.min(tokenExpiry, session.expiresAt)
        : session.expiresAt,
      address: session.address,
    };
    const plaintext = new TextEncoder().encode(token);
    try {
      const envelope: Envelope<TokenHeader> = {
        ...header,
        ...(await encrypt(key, header, plaintext)),
      };
      storage.setItem(TOKEN_KEY, JSON.stringify(envelope));
    } finally {
      zeroize(plaintext);
    }
  }

  async function unsealToken(address: string): Promise<string | null> {
    const record = readJson(TOKEN_KEY);
    if (record === null) return null;
    const session = sessionHeader(readJson(SESSION_KEY));
    const header = tokenHeader(record);
    if (
      session === null ||
      header === null ||
      header.keyId !== session.keyId ||
      !sameAddress(header.address, address) ||
      !sameAddress(session.address, address) ||
      now() >= header.expiresAt ||
      typeof record.iv !== 'string' ||
      typeof record.ct !== 'string'
    ) {
      remove(TOKEN_KEY);
      return null;
    }
    let plaintext: Uint8Array | undefined;
    try {
      const key = await keys.get(header.keyId);
      if (key === undefined) throw new Error('sealing key is gone');
      plaintext = await decrypt(key, header, record.iv, record.ct);
      return new TextDecoder().decode(plaintext);
    } catch {
      remove(TOKEN_KEY);
      return null;
    } finally {
      zeroize(plaintext);
    }
  }

  return { seal, unseal, sealToken, unsealToken, clear };
}

/** base64 to bytes, in the `ArrayBuffer`-backed shape WebCrypto's types want. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(base64.decode(text));
}

/** The AES-GCM additional data: the header, in a fixed field order. */
function aad(header: object): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(header));
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Rebuilds the header in its canonical field order, or `null` if malformed. */
function sessionHeader(record: Record<string, unknown> | null): SessionHeader | null {
  if (record === null) return null;
  const { v, keyId, expiresAt, credentialId, transports, accountIndex, address } = record;
  if (
    v !== 1 ||
    typeof keyId !== 'string' ||
    typeof expiresAt !== 'number' ||
    typeof credentialId !== 'string' ||
    credentialId.length === 0 ||
    !(
      transports === null ||
      (Array.isArray(transports) && transports.every((t) => typeof t === 'string'))
    ) ||
    typeof accountIndex !== 'number' ||
    !Number.isInteger(accountIndex) ||
    typeof address !== 'string'
  ) {
    return null;
  }
  return {
    v,
    keyId,
    expiresAt,
    credentialId,
    transports: transports as string[] | null,
    accountIndex,
    address,
  };
}

function tokenHeader(record: Record<string, unknown>): TokenHeader | null {
  const { v, keyId, expiresAt, address } = record;
  if (
    v !== 1 ||
    typeof keyId !== 'string' ||
    typeof expiresAt !== 'number' ||
    typeof address !== 'string'
  ) {
    return null;
  }
  return { v, keyId, expiresAt, address };
}
