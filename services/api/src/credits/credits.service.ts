import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { Principal } from '../auth/principal';
import { CREDITS_CONFIG, type CreditsConfig } from './credits.config';
import { CreditsRefusedError } from './credits.errors';
import {
  OpenRouterManagementClient,
  OpenRouterSharedKeyClient,
  type FetchLike,
  type SharedKeyApi,
  type LimitReset,
  type OpenRouterKey,
  type OpenRouterKeyApi,
} from './openrouter.client';
import { CREDIT_KEYS, type CreditKeyRecord, type CreditKeyStore } from './store/credit-key-store';

/** DI token for the OpenRouter key-management API (or its unconfigured stand-in). */
export const OPENROUTER_KEYS = Symbol('OPENROUTER_KEYS');

/** DI token for the shared inference key's `GET /key` reader. Null outside shared mode. */
export const OPENROUTER_SHARED = Symbol('OPENROUTER_SHARED');

/** How the free tier's limit resets: OpenRouter's monthly window, 00:00 UTC on the 1st. */
export const FREE_TIER_RESET: LimitReset = 'monthly';

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
    'Inference credits are not configured on this server (set OPENROUTER_MANAGEMENT_KEY, or OPENROUTER_API_KEY in dev)',
  );
}

/** The one place the configured/unconfigured choice is made; the module and specs share it. */
export function createOpenRouterKeys(config: CreditsConfig, fetch?: FetchLike): OpenRouterKeyApi {
  return config.managementKey
    ? new OpenRouterManagementClient({ managementKey: config.managementKey, fetch })
    : new UnconfiguredOpenRouterKeys();
}

/** Shared-key dev mode (SEN-18) reads its own limit and usage; null in every other mode. */
export function createSharedKey(config: CreditsConfig, fetch?: FetchLike): SharedKeyApi | null {
  return config.mode === 'shared' && config.sharedKey
    ? new OpenRouterSharedKeyClient({ apiKey: config.sharedKey, fetch })
    : null;
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

/**
 * Where a user stands (SEN-183): the view, plus what `GET /credits` needs to
 * describe it honestly — whether a key exists yet, and how its limit resets.
 */
export interface CreditStanding {
  /** False before the first run or `POST /credits/provision`: the view is the free tier, untouched. */
  provisioned: boolean;
  /** `shared`: the view is one dev key everyone draws on, not this user's. */
  mode: 'per-user' | 'shared';
  /** How OpenRouter resets the limit; null = never (a one-off allowance). */
  limitReset: LimitReset;
  view: CreditsView;
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
  /**
   * Keys this process has already tried to raise to the free tier, so a failed
   * PATCH is not retried on every read (the scheduler reads once a minute).
   */
  private readonly raiseTried = new Set<string>();

  constructor(
    @Inject(CREDITS_CONFIG) private readonly config: CreditsConfig,
    @Inject(OPENROUTER_KEYS) private readonly keys: OpenRouterKeyApi,
    @Inject(CREDIT_KEYS) private readonly store: CreditKeyStore,
    @Optional() @Inject(OPENROUTER_SHARED) private readonly shared?: SharedKeyApi | null,
  ) {}

  /** Mints the caller's key on first call; returns the existing one's status after. */
  provision(principal: Principal): Promise<ProvisionResult> {
    if (this.config.mode === 'shared') {
      // Dev mode: nothing to mint. Every user draws on the one shared key.
      return this.sharedView(new Date()).then((view) => ({ ...view, created: false }));
    }
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

  async status(principal: Principal, now: Date = new Date()): Promise<CreditsView> {
    if (this.config.mode === 'shared') {
      return this.sharedView(now);
    }
    const record = await this.requireRecord(principal.userId);
    return toView(await this.readKey(record.hash), now);
  }

  /**
   * `GET /credits` (SEN-183). Unlike `status`, a user with no key yet is not a
   * refusal: they are on the free tier with nothing spent, and reading their
   * credits must not mint a key (the first run does that).
   */
  async standing(principal: Principal, now: Date = new Date()): Promise<CreditStanding> {
    if (this.config.mode === 'shared') {
      const { view, limitReset } = await this.sharedRead(now);
      return { provisioned: true, mode: 'shared', limitReset, view };
    }
    const record = await this.store.find(principal.userId);
    if (!record) {
      if (this.config.mode === 'unconfigured') throw unconfigured();
      const limit = this.config.defaultLimitUsd;
      return {
        provisioned: false,
        mode: 'per-user',
        limitReset: FREE_TIER_RESET,
        view: {
          limitUsd: limit,
          remainingUsd: limit,
          usageMonthUsd: 0,
          resetsAt: nextResetUtc(FREE_TIER_RESET, now)?.toISOString() ?? null,
        },
      };
    }
    const key = await this.readKey(record.hash);
    return {
      provisioned: true,
      mode: 'per-user',
      limitReset: key.limit_reset,
      view: toView(key, now),
    };
  }

  /**
   * SERVER-ONLY. The plaintext key the agent runner spends the user's inference
   * budget with. Never route this into an HTTP response or a log line.
   */
  async keyFor(userId: string): Promise<string> {
    if (this.config.mode === 'shared' && this.config.sharedKey) {
      return this.config.sharedKey;
    }
    return (await this.requireRecord(userId)).key;
  }

  /** The shared key's limit and usage. It is everyone's budget, so the view says nothing per user. */
  private async sharedView(now: Date): Promise<CreditsView> {
    return (await this.sharedRead(now)).view;
  }

  private async sharedRead(now: Date): Promise<{ view: CreditsView; limitReset: LimitReset }> {
    if (!this.shared) {
      throw unconfigured();
    }
    try {
      const info = await this.shared.currentKey();
      const limitReset = info.limit_reset ?? null;
      return {
        limitReset,
        view: {
          limitUsd: info.limit,
          remainingUsd: info.limit_remaining,
          usageMonthUsd: info.usage_monthly ?? info.usage,
          resetsAt: nextResetUtc(limitReset, now)?.toISOString() ?? null,
        },
      };
    } catch (error) {
      throw asRefusal(error, 'status_unavailable', 'Could not read the shared OpenRouter key');
    }
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
        limit_reset: FREE_TIER_RESET,
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
    let key: OpenRouterKey;
    try {
      key = await this.keys.getKey(hash);
    } catch (error) {
      throw asRefusal(error, 'status_unavailable', 'Could not read the OpenRouter key');
    }
    return this.raiseToFreeTier(key);
  }

  /**
   * SEN-183 migration: a key minted under an older, lower default (5 USD) is
   * raised to today's free tier the first time it is read. Idempotent — a key
   * already at or above the free tier is never touched, so this only ever
   * RAISES; a limit is never lowered here. Only keys that look like ours and
   * like the free tier qualify: named `sente:<userId>` and resetting monthly.
   * A failed PATCH is logged and not retried by this process; the read still
   * answers with the key as it is.
   */
  private async raiseToFreeTier(key: OpenRouterKey): Promise<OpenRouterKey> {
    const target = this.config.defaultLimitUsd;
    const qualifies =
      key.limit !== null &&
      key.limit < target &&
      key.limit_reset === FREE_TIER_RESET &&
      typeof key.name === 'string' &&
      key.name.startsWith('sente:') &&
      !key.disabled;
    if (!qualifies || this.raiseTried.has(key.hash)) {
      return key;
    }
    this.raiseTried.add(key.hash);
    try {
      const raised = await this.keys.updateKey(key.hash, { limit: target });
      this.logger.log(`raised an OpenRouter key from $${key.limit} to the $${target} free tier`);
      return raised;
    } catch (error) {
      this.logger.warn(`could not raise an OpenRouter key to the free tier: ${errorText(error)}`);
      return key;
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
