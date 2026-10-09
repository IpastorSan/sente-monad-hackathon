/**
 * Perpl API-key enrollment for the user's own wallet, and the server's
 * read-only key (SEN-100, plan M-T18, "Architecture §3", D1–D4).
 *
 * ONE prepare enrolls TWO keys, both owned by the user's Privy wallet:
 *
 * - `trade`: the phone's Ed25519 key (HKDF from the device key, D2). The
 *   phone holds its secret and places orders itself (D1). The server sees its
 *   PUBLIC key and, afterwards, its api-key token — neither can trade alone.
 * - `read`: a key the server generates here, read-scoped, held in memory and
 *   sealed (D3) for Portfolio. A restart forgets it; the next enrollment
 *   relinks it.
 *
 * The wallet's secp256k1 signature over each payload comes from Privy's
 * `eth_signTypedData_v4`, which a device-owned wallet runs only with the
 * phone's authorization signature. So PREPARE composes both Privy requests
 * and the payloads the device key signs, and sends nothing; COMMIT forwards
 * the phone's signatures ALONE — no server approval is ever attached, the
 * same rule as `commitSend` — then submits both enrollments to Perpl.
 *
 * The SEN-42/44 prepare→commit rules hold: the Privy requests are stored and
 * sent verbatim (the signature covers their bytes); a prepare is single-use
 * and lives {@link PREPARED_APPROVAL_TTL_MS}; one live prepare per user. Each
 * Privy request carries `privy-idempotency-key` `sente-enroll:<prepareId>:<role>`,
 * a signed header, so a replayed signature is deduplicated by Privy for 24h.
 *
 * Every payload is checked against what was asked for before it is offered
 * (`perpl-enroll-format.ts`) — fail closed on drift (D4, gotcha 13).
 */
import { createPrivateKey, randomUUID, sign as signBytes } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthorizationPayload } from '@sente/mandate';
import {
  newSecretKey,
  PerplEnrollmentError,
  publicKeyOf,
  requestEnrollPayload,
  submitEnrollment,
  type ApiKeyInfo,
  type PerplNetwork,
  type PerplTypedData,
} from '@sente/venues/perpl';
import { bytesToHex, hexToBytes, type Address, type Hex, type TypedDataDefinition } from 'viem';

import { toPrivyTypedData } from '../agents/privy/agent-wallet';
import { PrivyError, type PrivyClient } from '../agents/privy/privy.client';
import { PREPARED_APPROVAL_TTL_MS } from '../agents/prepared-approval';
import type { PerplAccountReader } from '../agents/venues/perpl-agent';
import type { Principal } from '../auth/principal';
import {
  USER_WALLET_REGISTRY,
  type UserWalletRegistry,
} from '../wallet/store/user-wallet-registry';
import { WalletRefusedError, walletRefusalToHttpException } from '../wallet/wallet.errors';
import { enrollIdempotencyKey } from './idempotency-key';
import {
  enrollPayloadProblem,
  PERPL_ENROLL_FIELDS,
  READ_KEY_LABEL,
  type EnrollRole,
} from './perpl-enroll-format';
import { TRADE_CONFIG, type TradeConfig } from './trade.config';
import { USER_VENUE_SECRETS, type UserVenueSecretStore } from './user-venue-secrets';

/** DI token: the Privy client enrollment signs through, or null when unconfigured. */
export const ENROLL_PRIVY = Symbol('ENROLL_PRIVY');
/** DI token: which Perpl, how to read an account id, and (for tests) `fetch`. */
export const ENROLL_PERPL = Symbol('ENROLL_PERPL');

export type EnrollPrivy = Pick<PrivyClient, 'authorizationPayload' | 'request'>;

export interface EnrollPerpl {
  readonly network: PerplNetwork;
  readonly accountOf: PerplAccountReader;
  readonly fetchImpl?: typeof fetch;
}

// Both live in erasable modules so the phone's contract test runs the real ones.
export { enrollIdempotencyKey } from './idempotency-key';
export { READ_KEY_LABEL } from './perpl-enroll-format';

/** What the app shows when Perpl's payload drifted (D4). */
const FORMAT_CHANGED = 'Perpl changed its sign-up format; update the app';

/** Items are always in this order, and `signatures[i]` signs `items[i]`. */
const ROLES: readonly EnrollRole[] = ['trade', 'read'];

export interface EnrollPrepareItem {
  readonly role: EnrollRole;
  /** What the device key signs: the Privy `eth_signTypedData_v4` request. */
  readonly payload: AuthorizationPayload;
  /** Perpl's typed data verbatim; the phone hashes it itself for the trade key's PoP. */
  readonly typedData: PerplTypedData;
}

export interface EnrollPrepareResult {
  readonly prepareId: string;
  readonly expiresAt: string;
  readonly items: readonly EnrollPrepareItem[];
}

export interface EnrollCommitResult {
  /** The trade key's api-key token. Not secret on its own (D1). */
  readonly apiKey: string;
  readonly accountId: string;
  readonly readKey: 'linked';
}

export type PerplEnrollRefusalReason =
  | 'trading_disabled'
  | 'perpl_not_onboarded'
  | 'perpl_enroll_refused'
  | 'perpl_format_changed'
  | 'enroll_prepare_not_found';

const REFUSAL_STATUS: Record<PerplEnrollRefusalReason, HttpStatus> = {
  trading_disabled: HttpStatus.NOT_FOUND,
  perpl_not_onboarded: HttpStatus.UNPROCESSABLE_ENTITY,
  perpl_enroll_refused: HttpStatus.UNPROCESSABLE_ENTITY,
  // Upstream changed under us; nothing the user can fix but updating the app.
  perpl_format_changed: HttpStatus.BAD_GATEWAY,
  // Unknown, expired, already committed, or another user's: all look the same.
  enroll_prepare_not_found: HttpStatus.NOT_FOUND,
};

export class PerplEnrollRefusedError extends Error {
  readonly reason: PerplEnrollRefusalReason;

  constructor(reason: PerplEnrollRefusalReason, message: string) {
    super(message);
    this.name = 'PerplEnrollRefusedError';
    this.reason = reason;
  }
}

/** Maps enrollment and wallet refusals to a 4xx/5xx with a stable `reason`; rethrows the rest. */
export function enrollRefusalToHttpException(error: unknown): unknown {
  if (error instanceof WalletRefusedError) return walletRefusalToHttpException(error);
  if (!(error instanceof PerplEnrollRefusedError)) return error;
  const statusCode = REFUSAL_STATUS[error.reason];
  return new HttpException(
    { statusCode, reason: error.reason, message: error.message },
    statusCode,
  );
}

/**
 * An Ed25519 secret that prints nothing: the pending read key sits in memory
 * for up to five minutes, and a logged prepare must not carry it.
 */
class SealedSecret {
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  get bytes(): Uint8Array {
    return this.#bytes;
  }
  wipe(): void {
    this.#bytes.fill(0);
  }
  toString(): string {
    return '[secret redacted]';
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

interface PendingItem {
  readonly role: EnrollRole;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly payload: AuthorizationPayload;
  readonly typed_data: PerplTypedData;
  readonly mac: string;
  readonly digest: Hex;
}

interface PendingEnrollment {
  readonly id: string;
  readonly userId: string;
  readonly address: Address;
  readonly accountId: bigint;
  readonly items: readonly PendingItem[];
  readonly readSecret: SealedSecret;
  readonly expiresAt: Date;
}

@Injectable()
export class PerplEnrollService {
  private readonly logger = new Logger(PerplEnrollService.name);
  /** prepareId -> pending. At most one per user (see `#byUser`). */
  readonly #pending = new Map<string, PendingEnrollment>();
  readonly #byUser = new Map<string, string>();

  constructor(
    @Inject(TRADE_CONFIG) private readonly config: TradeConfig,
    @Inject(USER_WALLET_REGISTRY) private readonly registry: Pick<UserWalletRegistry, 'find'>,
    @Inject(ENROLL_PRIVY) private readonly privy: EnrollPrivy | null,
    @Inject(ENROLL_PERPL) private readonly perpl: EnrollPerpl,
    @Inject(USER_VENUE_SECRETS) private readonly secrets: UserVenueSecretStore,
  ) {}

  async prepare(
    principal: Principal,
    input: { publicKeyHex: Hex; label: string },
  ): Promise<EnrollPrepareResult> {
    this.assertEnabled();
    const privy = this.requirePrivy();
    const binding = await this.registry.find(principal.userId);
    if (!binding) {
      throw new WalletRefusedError(
        'account_not_registered',
        'No wallet for this user; POST /wallet/register with the device public key first',
      );
    }
    const accountId = await this.perpl.accountOf(binding.address);
    if (accountId === null) {
      throw new PerplEnrollRefusedError(
        'perpl_not_onboarded',
        `${binding.address} has no Perpl account yet; onboard it first`,
      );
    }

    const now = this.now();
    const id = randomUUID();
    const readSecret = new SealedSecret(newSecretKey());
    const keys: Record<EnrollRole, { publicKeyHex: Hex; label: string }> = {
      trade: { publicKeyHex: input.publicKeyHex.toLowerCase() as Hex, label: input.label },
      read: { publicKeyHex: bytesToHex(publicKeyOf(readSecret.bytes)), label: READ_KEY_LABEL },
    };

    try {
      const items: PendingItem[] = [];
      for (const role of ROLES) {
        const { publicKeyHex, label } = keys[role];
        const fetched = await this.perplCall(
          () =>
            requestEnrollPayload({
              restUrl: this.perpl.network.restUrl,
              chainId: this.perpl.network.chainId,
              address: binding.address,
              publicKeyHex,
              scope: PERPL_ENROLL_FIELDS.scopeMask[role],
              label,
              fetchImpl: this.perpl.fetchImpl,
            }),
          'payload',
        );
        const problem = enrollPayloadProblem(fetched.typed_data, {
          role,
          chainId: this.perpl.network.chainId,
          signer: binding.address,
          publicKeyHex,
          label,
          now,
        });
        if (problem) {
          this.logger.warn(`Perpl ${role} enrollment payload drifted: ${problem}`);
          throw new PerplEnrollRefusedError('perpl_format_changed', FORMAT_CHANGED);
        }
        const path = `/v1/wallets/${binding.walletId}/rpc`;
        const body = {
          method: 'eth_signTypedData_v4',
          params: {
            typed_data: toPrivyTypedData(fetched.typedData as unknown as TypedDataDefinition),
          },
        };
        const idempotencyKey = enrollIdempotencyKey(id, role);
        items.push({
          role,
          path,
          body,
          idempotencyKey,
          // Built by the client that will send it, so the two cannot drift.
          payload: privy.authorizationPayload('POST', path, body, { idempotencyKey }),
          typed_data: fetched.typed_data,
          mac: fetched.mac,
          digest: fetched.digest,
        });
      }

      const pending: PendingEnrollment = {
        id,
        userId: principal.userId,
        address: binding.address,
        accountId,
        items,
        readSecret,
        expiresAt: new Date(now.getTime() + PREPARED_APPROVAL_TTL_MS),
      };
      this.put(pending, now);
      return {
        prepareId: id,
        expiresAt: pending.expiresAt.toISOString(),
        items: items.map(({ role, payload, typed_data }) => ({
          role,
          payload,
          typedData: typed_data,
        })),
      };
    } catch (error) {
      readSecret.wipe();
      throw error;
    }
  }

  async commit(
    principal: Principal,
    input: { prepareId: string; signatures: readonly string[]; popSignature: Hex },
  ): Promise<EnrollCommitResult> {
    this.assertEnabled();
    const privy = this.requirePrivy();
    const pending = this.take(input.prepareId, principal.userId, this.now());
    if (!pending) {
      throw new PerplEnrollRefusedError(
        'enroll_prepare_not_found',
        `No enrollment ${input.prepareId}; prepare it again`,
      );
    }

    try {
      if (input.signatures.length !== pending.items.length) {
        throw new PerplEnrollRefusedError(
          'perpl_enroll_refused',
          `expected ${pending.items.length} signatures, got ${input.signatures.length}`,
        );
      }
      const walletSignatures = new Map<EnrollRole, Hex>();
      for (const [i, item] of pending.items.entries()) {
        walletSignatures.set(item.role, await this.walletSign(privy, item, input.signatures[i]!));
      }

      // Read first: if it fails, nothing of the phone's is registered and a
      // retry starts clean. If the trade key then fails, the read key stays
      // linked — it is ours, and Portfolio can use it.
      const read = this.item(pending, 'read');
      const readInfo = await this.submit(pending, read, walletSignatures.get('read')!, {
        popSignature: ed25519Sign(pending.readSecret.bytes, read.digest),
      });
      await this.secrets.putPerplRead(principal.userId, {
        apiKey: readInfo.api_key,
        secretKey: pending.readSecret.bytes,
      });

      const trade = this.item(pending, 'trade');
      const tradeInfo = await this.submit(pending, trade, walletSignatures.get('trade')!, {
        popSignature: input.popSignature,
      });
      await this.secrets.putPerplTradeToken(principal.userId, tradeInfo.api_key);
      this.logger.log(`Perpl keys enrolled for account ${pending.accountId}`);
      return {
        apiKey: tradeInfo.api_key,
        accountId: pending.accountId.toString(),
        readKey: 'linked',
      };
    } finally {
      // The store holds its own copy of the read secret.
      pending.readSecret.wipe();
    }
  }

  /** Overridable clock for the spec. */
  protected now(): Date {
    return new Date();
  }

  private item(pending: PendingEnrollment, role: EnrollRole): PendingItem {
    return pending.items.find((item) => item.role === role)!;
  }

  /**
   * The wallet's EIP-712 signature: the stored request, with the phone's
   * authorization signature forwarded verbatim and ALONE. No `approvals`:
   * a server key on this request would be a server that signs for the user.
   */
  private async walletSign(privy: EnrollPrivy, item: PendingItem, signature: string): Promise<Hex> {
    try {
      const response = await privy.request<{ data?: { signature?: Hex } }>(
        'POST',
        item.path,
        item.body,
        { signatures: [signature], idempotencyKey: item.idempotencyKey },
      );
      const signed = response.data?.signature;
      if (!signed) throw new Error('Privy answered without a signature');
      return signed;
    } catch (error) {
      if (error instanceof PrivyError && error.isMissingApproval) {
        throw new WalletRefusedError(
          'invalid_authorization',
          `Privy refused the device signature for the ${item.role} key`,
        );
      }
      throw new PerplEnrollRefusedError(
        'perpl_enroll_refused',
        `Signing the ${item.role} enrollment failed: ${describe(error)}`,
      );
    }
  }

  private submit(
    pending: PendingEnrollment,
    item: PendingItem,
    signature: Hex,
    { popSignature }: { popSignature: Hex },
  ): Promise<ApiKeyInfo> {
    return this.perplCall(
      () =>
        submitEnrollment({
          restUrl: this.perpl.network.restUrl,
          chainId: this.perpl.network.chainId,
          address: pending.address,
          typed_data: item.typed_data,
          mac: item.mac,
          signature,
          popSignature,
          fetchImpl: this.perpl.fetchImpl,
        }),
      'submit',
    );
  }

  /**
   * Perpl's HTTP refusals become `perpl_enroll_refused`. Anything else thrown
   * while READING a payload — another signer, typed data that no longer
   * hashes — means Perpl served something we did not ask for: that is drift,
   * and it fails closed as `perpl_format_changed` (D4). At submit time any
   * other error is ours, and propagates as a 500.
   */
  private async perplCall<T>(run: () => Promise<T>, phase: 'payload' | 'submit'): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // PerplEnrollmentError carries Perpl's status and hint in its message.
      if (error instanceof PerplEnrollmentError) {
        throw new PerplEnrollRefusedError('perpl_enroll_refused', error.message);
      }
      if (phase === 'payload' && error instanceof Error) {
        this.logger.warn(`Perpl enrollment payload unusable: ${error.message}`);
        throw new PerplEnrollRefusedError('perpl_format_changed', FORMAT_CHANGED);
      }
      throw error;
    }
  }

  /** One live prepare per user: a new one supersedes (and wipes) the last. */
  private put(pending: PendingEnrollment, now: Date): void {
    this.sweep(now);
    const superseded = this.#byUser.get(pending.userId);
    if (superseded !== undefined) this.forget(superseded);
    this.#pending.set(pending.id, pending);
    this.#byUser.set(pending.userId, pending.id);
  }

  /** Single-use: consumes on read. Undefined for unknown, expired, or another user's id. */
  private take(id: string, userId: string, now: Date): PendingEnrollment | undefined {
    const found = this.#pending.get(id);
    // A wrong-user guess must not consume the owner's prepare.
    if (!found || found.userId !== userId) return undefined;
    this.#pending.delete(id);
    if (this.#byUser.get(userId) === id) this.#byUser.delete(userId);
    if (found.expiresAt.getTime() <= now.getTime()) {
      found.readSecret.wipe();
      return undefined;
    }
    return found;
  }

  /** Same TTL for all, Map in insertion order: stop at the first live one. */
  private sweep(now: Date): void {
    for (const pending of this.#pending.values()) {
      if (pending.expiresAt.getTime() > now.getTime()) return;
      this.forget(pending.id);
    }
  }

  private forget(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    pending.readSecret.wipe();
    this.#pending.delete(id);
    if (this.#byUser.get(pending.userId) === id) this.#byUser.delete(pending.userId);
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new PerplEnrollRefusedError('trading_disabled', 'Manual trading is not enabled here');
    }
  }

  private requirePrivy(): EnrollPrivy {
    if (!this.privy) {
      throw new WalletRefusedError(
        'user_wallets_unconfigured',
        'Privy is not configured, so no enrollment can be signed. Set PRIVY_APP_ID and PRIVY_APP_SECRET.',
      );
    }
    return this.privy;
  }
}

/**
 * Ed25519 over the EIP-712 digest with node's own crypto, so the API needs no
 * second Ed25519 library. The raw 32-byte seed goes in as PKCS#8 DER: the
 * fixed 16-byte prefix is RFC 8410's.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519Sign(secretKey: Uint8Array, digest: Hex): Hex {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey)]);
  try {
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return bytesToHex(signBytes(null, hexToBytes(digest), key));
  } finally {
    der.fill(0);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
