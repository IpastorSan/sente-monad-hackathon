// The agents' venue secrets, on disk and encrypted (SEN-148).
//
// Why durable: an agent's Perpl API key lived in `InMemoryAgentSecretStore`,
// so every restart forgot it and the next use enrolled a new one. A Perpl
// account holds at most 16 active keys and a revoked key cannot be reused, so
// each restart burnt a slot; after 16 the agent could never trade Perpl again.
//
// Why encrypted: the Ed25519 secret signs every Perpl order the agent sends.
// `STATE_DIR` is a plain directory (0700, files 0600) on a host bind mount; a
// copy of it, a backup or a stray `cat` must not be enough to trade as the
// agent. Each record is sealed with AES-256-GCM under `AGENT_SECRETS_KEY`, a
// key that lives in the environment and never in `STATE_DIR`, with the agent
// id as associated data so a record cannot be moved onto another agent.
//
// A wrong key is FATAL at boot, never an empty store: every record is
// decrypted on load, and GCM's tag refuses a wrong key. Starting empty would
// look like success and re-enroll every agent — the exact slot burn this file
// exists to stop. Same rule as `state/json-file.ts` for an unreadable file.
//
// Only exercised against real Perpl once deployed: the specs run on fakes.
//
// Erasable syntax and `.ts` specifiers only (scripts load the venue files).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PerplCredentials } from '@sente/venues/perpl';

import { JsonRecordFile } from '../../state/json-file.ts';
import { sealPerplCredentials, type AgentSecretStore } from './agent-secret-store.ts';

/** The env var holding the at-rest key: 64 hex chars (`openssl rand -hex 32`). */
export const AGENT_SECRETS_KEY_VAR = 'AGENT_SECRETS_KEY';

/** The file name under `STATE_DIR`. */
export const AGENT_SECRETS_FILE = 'agent-secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** Versioned so a later format change can tell old records apart. */
const AAD_PREFIX = 'sente/agent-secrets/v1/perpl/';

/** One sealed secret, all fields base64. */
export interface Sealed {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** What the file holds per agent. Nothing in it is readable without the key. */
interface SecretRecord {
  readonly agentId: string;
  readonly perpl: Sealed;
}

/**
 * The at-rest key from `AGENT_SECRETS_KEY`. Throws when it is missing or not
 * 32 bytes of hex: with `STATE_DIR` set there is no safe fallback — a
 * plaintext file leaks keys, and a random key orphans them at the next boot.
 */
export function agentSecretsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const value = env[AGENT_SECRETS_KEY_VAR]?.trim();
  if (!value) {
    throw new Error(
      `${AGENT_SECRETS_KEY_VAR} is required when STATE_DIR is set: it encrypts the agents' ` +
        "and users' Perpl keys at rest. Generate one with `openssl rand -hex 32` and keep it OUT of STATE_DIR.",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${AGENT_SECRETS_KEY_VAR} must be 64 hex characters (openssl rand -hex 32)`);
  }
  return Buffer.from(value, 'hex');
}

/**
 * AES-256-GCM over `plain` under `key`, bound to `aad` (a versioned label plus
 * the record's owner, so a record cannot be moved onto another owner). Zeroes
 * `plain`. Shared with the users' venue secrets (SEN-174).
 */
export function sealBytes(key: Uint8Array, aad: string, plain: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * The inverse of {@link sealBytes}. Throws on a wrong key, a tampered record
 * or a different `aad`. The caller zeroes the returned buffer.
 */
export function unsealBytes(key: Uint8Array, aad: string, sealed: Sealed): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

/** Perpl credentials as the plaintext both secret files seal: JSON, secret in base64. */
export function encodePerplCredentials(credentials: PerplCredentials): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiKey: credentials.apiKey,
      secretKey: Buffer.from(credentials.secretKey).toString('base64'),
    }),
    'utf8',
  );
}

/** The inverse of {@link encodePerplCredentials}: sealed credentials. Zeroes `plain`. */
export function decodePerplCredentials(plain: Buffer): PerplCredentials {
  try {
    const parsed = JSON.parse(plain.toString('utf8')) as { apiKey: string; secretKey: string };
    const secretKey = Buffer.from(parsed.secretKey, 'base64');
    const credentials = sealPerplCredentials({ apiKey: parsed.apiKey, secretKey });
    secretKey.fill(0);
    return credentials;
  } finally {
    plain.fill(0);
  }
}

function seal(key: Uint8Array, agentId: string, credentials: PerplCredentials): Sealed {
  return sealBytes(key, AAD_PREFIX + agentId, encodePerplCredentials(credentials));
}

/** Throws on a wrong key, a tampered record or a record moved to another agent. */
function unseal(key: Uint8Array, agentId: string, sealed: Sealed): PerplCredentials {
  return decodePerplCredentials(unsealBytes(key, AAD_PREFIX + agentId, sealed));
}

export class FileAgentSecretStore implements AgentSecretStore {
  readonly #file: JsonRecordFile<SecretRecord>;
  readonly #key: Buffer;
  readonly #records = new Map<string, SecretRecord>();
  /** Decrypted once at load; handed out as sealed copies, like the in-memory store. */
  readonly #perpl = new Map<string, PerplCredentials>();

  /** Loads and decrypts eagerly, so a wrong key or a bad file fails the boot. */
  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error('the agent secrets key must be 32 bytes');
    this.#key = Buffer.from(key);
    this.#file = new JsonRecordFile<SecretRecord>(path);
    for (const record of this.#file.load()) {
      let credentials: PerplCredentials;
      try {
        credentials = unseal(this.#key, record.agentId, record.perpl);
      } catch (error) {
        // Deliberately no detail from `error`: it cannot hold the key, but
        // "unable to authenticate data" is all GCM ever says anyway.
        throw new Error(
          `${this.#file.path}: cannot decrypt agent ${record.agentId}'s Perpl key with ` +
            `${AGENT_SECRETS_KEY_VAR}. Refusing to start: a wrong key would re-enroll every agent ` +
            'and burn Perpl key slots (16 per account). Restore the key that wrote this file.',
          { cause: error },
        );
      }
      this.#records.set(record.agentId, record);
      this.#perpl.set(record.agentId, credentials);
    }
  }

  /** The file behind this store. Logged at boot. */
  get path(): string {
    return this.#file.path;
  }

  /** How many agents' secrets came back from disk. Logged at boot. */
  get size(): number {
    return this.#records.size;
  }

  getPerplCredentials(agentId: string): Promise<PerplCredentials | undefined> {
    const held = this.#perpl.get(agentId);
    return Promise.resolve(held ? sealPerplCredentials(held) : undefined);
  }

  putPerplCredentials(agentId: string, credentials: PerplCredentials): Promise<void> {
    const previousRecord = this.#records.get(agentId);
    const previous = this.#perpl.get(agentId);
    this.#records.set(agentId, { agentId, perpl: seal(this.#key, agentId, credentials) });
    this.#perpl.set(agentId, sealPerplCredentials(credentials));
    try {
      this.#persist();
    } catch (error) {
      // A key live in memory but absent from disk is a slot burnt at the next
      // restart. Undo, and let the caller see the enrollment did not stick.
      this.#restore(agentId, previousRecord, previous);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    previous?.secretKey.fill(0);
    return Promise.resolve();
  }

  deleteAgent(agentId: string): Promise<void> {
    const previousRecord = this.#records.get(agentId);
    const previous = this.#perpl.get(agentId);
    if (!previousRecord) return Promise.resolve();
    this.#records.delete(agentId);
    this.#perpl.delete(agentId);
    try {
      this.#persist();
    } catch (error) {
      this.#restore(agentId, previousRecord, previous);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    previous?.secretKey.fill(0);
    return Promise.resolve();
  }

  #restore(
    agentId: string,
    record: SecretRecord | undefined,
    credentials: PerplCredentials | undefined,
  ): void {
    if (record && credentials) {
      this.#records.set(agentId, record);
      this.#perpl.set(agentId, credentials);
    } else {
      this.#records.delete(agentId);
      this.#perpl.delete(agentId);
    }
  }

  #persist(): void {
    this.#file.save([...this.#records.values()]);
  }
}
