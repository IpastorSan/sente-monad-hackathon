/**
 * `POST /webhooks/alchemy` — SEN-30.
 *
 * Verify the signature over the raw bytes, resolve the credited address to a
 * hired agent, and append exactly one `deposit` event per transfer to that
 * agent's Ledger. Funding an agent otherwise shows up only when something polls;
 * this is the moment a demo wants to show, live.
 *
 * THE FOUR REFUSALS, and why each is the status it is. Alchemy retries non-2xx
 * deliveries with exponential backoff ("Webhooks Quickstart"), so the status code
 * decides whether a bad delivery comes back for ten minutes:
 *
 * | case | answer | why |
 * | --- | --- | --- |
 * | no `ALCHEMY_WEBHOOK_SIGNING_KEY` | 503 `webhook_unconfigured` | cannot authenticate, so cannot accept — and a retry is right, the operator may be mid-deploy |
 * | bad or missing signature | 401 `signature_invalid` | the only thing standing between a stranger and a fabricated deposit on someone's Ledger |
 * | body is not JSON, or not ADDRESS_ACTIVITY | 200, nothing appended | retrying will not make it parse; a `GRAPHQL` or `NFT_ACTIVITY` webhook pointed here is a configuration mistake, not a transient one |
 * | address is not a hired agent's | 200, nothing appended | the webhook may legitimately watch other addresses; nothing to do and nothing to retry |
 *
 * So only the first two are retried, and neither can append anything.
 */
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { AGENT_EVENTS, type AgentEventLog } from '../agents/events/agent-event-log';
import { ALCHEMY_CONFIG, type AlchemyConfig } from './alchemy.config';
import {
  depositKey,
  parseAlchemyAddressActivity,
  toDepositDetail,
  verifyAlchemySignature,
  type AgentDepositDetail,
} from './alchemy';

/** DI token for the address -> agent lookup. */
export const AGENT_ADDRESSES = Symbol('AGENT_ADDRESSES');

/**
 * Just enough of the agent store for this module: which agent, if any, owns a
 * wallet address.
 *
 * A narrow port rather than `AgentStore` itself, because `AgentStore` has no
 * address index (only `byId` and `idByTokenHash`) and adding one would mean
 * touching `InMemoryAgentStore`, `FileAgentStore` and every fake for a lookup
 * that happens once per deposit. `webhooks.module.ts` implements it over
 * `listActive()`, the way `LeaderboardService` matches indexer accounts.
 */
export interface AgentAddresses {
  /** Case-insensitive: Alchemy sends lower case, `AgentRecord.address` is EIP-55. */
  agentIdForAddress(address: string): Promise<string | undefined>;
}

/**
 * Why a verified delivery appended nothing. A union rather than a bare `string`
 * so the producer and the specs that pin these literals are related by the
 * compiler — `AlchemyParse` already types its half, and widening at this
 * boundary would throw that away. The `*.errors.ts` mapper the rest of the API
 * uses is deliberately NOT here: those exist because the mobile app branches on
 * their reasons, and this route's only client is Alchemy, which branches on the
 * status code alone.
 */
export const WEBHOOK_IGNORED_REASONS = [
  'body_not_json',
  'not_address_activity',
  'no_watched_agent',
  'already_seen',
  'append_failed',
] as const;
export type WebhookIgnoredReason = (typeof WEBHOOK_IGNORED_REASONS)[number];

/** What the route answers. Deliberately says nothing about which agents exist. */
export interface AlchemyWebhookAck {
  readonly received: true;
  /** How many `deposit` events this delivery appended. */
  readonly appended: number;
  /** Why nothing was appended, when nothing was. Absent when something was. */
  readonly ignored?: WebhookIgnoredReason;
}

/**
 * How many transfer identities to remember for idempotency.
 *
 * PERSISTENCE: process-local, like every other store in this API. That is not a
 * gap here: the event log is in memory too, so a restart loses the deposits a
 * re-delivery would duplicate, and there is nothing left to duplicate against.
 */
const SEEN_DEPOSITS_MAX = 10_000;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  /** `depositKey` of every transfer already appended, oldest evicted first. */
  private readonly seen = new Set<string>();

  constructor(
    @Inject(ALCHEMY_CONFIG) private readonly config: AlchemyConfig,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
    @Inject(AGENT_ADDRESSES) private readonly agents: AgentAddresses,
  ) {}

  async handleAlchemy(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<AlchemyWebhookAck> {
    const signingKey = this.config.webhookSigningKey;
    if (!signingKey) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        reason: 'webhook_unconfigured',
        message:
          'ALCHEMY_WEBHOOK_SIGNING_KEY is not set, so this delivery cannot be verified and is ' +
          'not accepted',
      });
    }
    // An absent raw body means the middleware did not run — a wiring mistake, not
    // a caller's. Treated as unsigned rather than trusted.
    if (!rawBody || !verifyAlchemySignature(rawBody, signature, signingKey)) {
      this.logger.warn(
        `refused an Alchemy delivery: ${signature ? 'signature did not verify' : 'no X-Alchemy-Signature header'}`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        reason: 'signature_invalid',
        message: 'X-Alchemy-Signature is missing or does not match the signing key',
      });
    }

    const parsed = parseAlchemyAddressActivity(rawBody);
    if (!parsed.ok) {
      this.logger.warn(`ignored a verified Alchemy delivery: ${parsed.reason}`);
      return { received: true, appended: 0, ignored: parsed.reason };
    }

    let appended = 0;
    let duplicates = 0;
    let failed = 0;
    for (const [index, activity] of parsed.payload.event.activity.entries()) {
      // The cheap checks first: most entries in a delivery are for addresses
      // this server does not care about, and a retry's entries are all already
      // seen. Neither case should build a detail object only to drop it.
      const agentId = await this.agents.agentIdForAddress(activity.toAddress);
      if (agentId === undefined) continue;
      const key = depositKey(activity, index);
      if (this.seen.has(key)) {
        duplicates += 1;
        continue;
      }
      const detail = toDepositDetail(parsed.payload, activity, index);
      if (!detail) continue;
      // Reserved BEFORE the append, so two deliveries in flight for the same
      // transfer cannot both get past this line — and RELEASED when the append
      // fails, or a transient log failure would lose the deposit for good: the
      // key would stay reserved while the 200 below tells Alchemy not to retry.
      this.remember(key);
      if (await this.appendDeposit(agentId, detail)) {
        appended += 1;
      } else {
        this.seen.delete(key);
        failed += 1;
      }
    }

    if (appended > 0) return { received: true, appended };
    const ignored: WebhookIgnoredReason =
      duplicates > 0 ? 'already_seen' : failed > 0 ? 'append_failed' : 'no_watched_agent';
    return { received: true, appended: 0, ignored };
  }

  /**
   * Appends, and never lets the log decide the outcome — the same rule
   * `agents/tools/gate.ts#record` follows. The caller releases the key on
   * `false`, so the delivery stays replayable; what is lost is only this
   * attempt, and the reason is in the log.
   */
  private async appendDeposit(agentId: string, detail: AgentDepositDetail): Promise<boolean> {
    try {
      await this.events.append({ agentId, kind: 'deposit', detail });
      this.logger.log(
        `deposit ${detail.amount} ${detail.asset} to agent ${agentId} ` +
          `(${detail.txHash} block ${detail.blockNumber}, delivery ${detail.deliveryId})`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `could not record a deposit for agent ${agentId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size <= SEEN_DEPOSITS_MAX) return;
    // Sets iterate in insertion order, so this is the oldest key.
    const oldest = this.seen.values().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}
