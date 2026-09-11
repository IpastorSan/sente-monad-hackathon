import { Inject, Injectable, Logger } from '@nestjs/common';

import type { GasDripPrincipal } from '../gas/auth/gas-drip-auth';
import { CREDITS_CONFIG, type CreditsConfig } from './credits.config';
import { CreditsRefusedError } from './credits.errors';
import {
  OpenRouterManagementClient,
  type FetchLike,
  type LimitReset,
  type OpenRouterKey,
  type OpenRouterKeyApi,
} from './openrouter.client';
import { CREDIT_KEYS, type CreditKeyRecord, type CreditKeyStore } from './store/credit-key-store';

/** DI token for the OpenRouter key-management API (or its unconfigured stand-in). */
export const OPENROUTER_KEYS = Symbol('OPENROUTER_KEYS');

/**
 * Bound when OPENROUTER_MANAGEMENT_KEY is unset. Every call refuses with
 * `credits_unconfigured` instead of failing somewhere less legible — the same
 * move as `wallet/`'s `UnconfiguredSponsorship`.
 */
export class UnconfiguredOpenRouterKeys implements OpenRouterKeyApi {
  createKey(): never {
    throw unconfigured();
  }
  getKey(): never {
    throw unconfigured();
  }
  updateKey(): never {
    throw unconfigured();
  }
  deleteKey(): never {
    throw unconfigured();
  }
}

function unconfigured(): CreditsRefusedError {
  return new CreditsRefusedError(
    'credits_unconfigured',
    'Inference credits are not configured on this server (OPENROUTER_MANAGEMENT_KEY is unset)',
  );
}

/** The one place the configured/unconfigured choice is made; the module and specs share it. */
export function createOpenRouterKeys(config: CreditsConfig, fetch?: FetchLike): OpenRouterKeyApi {
  return config.managementKey
    ? new OpenRouterManagementClient({ managementKey: config.managementKey, fetch })
    : new UnconfiguredOpenRouterKeys();
}

/** What a user may see about their own credits. No key, no hash. */
export interface CreditsView {
  /** Hard spending limit per reset window, USD. Null = unlimited (never set by us). */
  limitUsd: number | null;
  remainingUsd: number | null;
  usageMonthUsd: number;
  /** ISO 8601 instant the limit next resets, or null if it never does. */
  resetsAt: string | null;
}

export interface ProvisionResult extends CreditsView {
  /** False when the user already had a key and this call was a no-op. */
  created: boolean;
}

/**
 * Per-user OpenRouter keys ARE the credit system: each key carries a hard USD
 * limit that resets monthly, and OpenRouter meters and enforces it. We do no
 * metering of our own — `status` is a read-through of the key.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);
  /** Single-process dedupe: concurrent provisions for one user share one mint. */
  private readonly inFlight = new Map<string, Promise<ProvisionResult>>();

  constructor(
    @Inject(CREDITS_CONFIG) private readonly config: CreditsConfig,
    @Inject(OPENROUTER_KEYS) private readonly keys: OpenRouterKeyApi,
    @Inject(CREDIT_KEYS) private readonly store: CreditKeyStore,
  ) {}

  /** Mints the caller's key on first call; returns the existing one's status after. */
  provision(principal: GasDripPrincipal): Promise<ProvisionResult> {
    const pending = this.inFlight.get(principal.userId);
    if (pending) {
      return pending;
    }
    const run = this.provisionOnce(principal.userId).finally(() =>
      this.inFlight.delete(principal.userId),
    );
    this.inFlight.set(principal.userId, run);
    return run;
  }

  async status(principal: GasDripPrincipal, now: Date = new Date()): Promise<CreditsView> {
    const record = await this.requireRecord(principal.userId);
    return toView(await this.readKey(record.hash), now);
  }

  /**
   * SERVER-ONLY. The plaintext key the agent runner spends the user's inference
   * budget with. Never route this into an HTTP response or a log line.
   */
  async keyFor(userId: string): Promise<string> {
    return (await this.requireRecord(userId)).key;
  }

  private async provisionOnce(userId: string): Promise<ProvisionResult> {
    const existing = await this.store.find(userId);
    if (existing) {
      return { ...toView(await this.readKey(existing.hash), new Date()), created: false };
    }

    let created: Awaited<ReturnType<OpenRouterKeyApi['createKey']>>;
    try {
      created = await this.keys.createKey({
        name: `sente:${userId}`,
        limit: this.config.defaultLimitUsd,
        limit_reset: 'monthly',
        include_byok_in_limit: true,
        external: { user: userId },
      });
    } catch (error) {
      throw asRefusal(error, 'provision_failed', 'Could not create an OpenRouter key');
    }

    const claim = await this.store.claim({ userId, hash: created.data.hash, key: created.key });
    if (!claim.ok) {
      // Another replica won the race. Its key is the user's key; ours must not
      // live on as an orphan with budget attached.
      await this.discard(created.data.hash);
      return { ...toView(await this.readKey(claim.existing.hash), new Date()), created: false };
    }

    this.logger.log(`provisioned OpenRouter key for user ${userId}`);
    return { ...toView(created.data, new Date()), created: true };
  }

  private async requireRecord(userId: string): Promise<CreditKeyRecord> {
    const record = await this.store.find(userId);
    if (!record) {
      throw new CreditsRefusedError('not_provisioned', 'No credits yet: POST /credits/provision');
    }
    return record;
  }

  private async readKey(hash: string): Promise<OpenRouterKey> {
    try {
      return await this.keys.getKey(hash);
    } catch (error) {
      throw asRefusal(error, 'status_unavailable', 'Could not read the OpenRouter key');
    }
  }

  private async discard(hash: string): Promise<void> {
    try {
      await this.keys.deleteKey(hash);
    } catch (error) {
      // Still capped by its own limit, so this is waste rather than exposure.
      this.logger.error(`failed to delete a duplicate OpenRouter key: ${errorText(error)}`);
    }
  }
}

function toView(key: OpenRouterKey, now: Date): CreditsView {
  return {
    limitUsd: key.limit,
    remainingUsd: key.limit_remaining,
    usageMonthUsd: key.usage_monthly,
    resetsAt: nextResetUtc(key.limit_reset, now)?.toISOString() ?? null,
  };
}

/** OpenRouter resets limits at 00:00 UTC; weekly windows start on Monday. */
export function nextResetUtc(reset: LimitReset, now: Date): Date | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (reset) {
    case 'daily':
      return new Date(Date.UTC(y, m, d + 1));
    case 'weekly':
      // getUTCDay: Sunday = 0. Days until the next Monday, never zero.
      return new Date(Date.UTC(y, m, d + ((8 - now.getUTCDay()) % 7 || 7)));
    case 'monthly':
      return new Date(Date.UTC(y, m + 1, 1));
    default:
      return null;
  }
}

/** Refusals pass through untouched (notably `credits_unconfigured`); anything else is wrapped. */
function asRefusal(
  error: unknown,
  reason: 'provision_failed' | 'status_unavailable',
  message: string,
): CreditsRefusedError {
  if (error instanceof CreditsRefusedError) {
    return error;
  }
  return new CreditsRefusedError(reason, `${message}: ${errorText(error)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
