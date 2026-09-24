/**
 * Adding a hired agent's wallet to the Notify webhook's address list — SEN-30,
 * step 3.
 *
 * FAIL SOFT, exactly like the ERC-8004 registration on hire
 * (`agents/reputation/erc8004.ts#registerOnHire`): a webhook that cannot be
 * updated must never fail a hire. The consequence of a failure is that deposits
 * to that agent do not appear in its Ledger until someone adds the address by
 * hand — a missing feature, not a lost wallet — so `watchAddress` never throws
 * and returns a typed reason instead.
 *
 * THE ENDPOINT IS NOT INVENTED. Alchemy documents
 * `PATCH https://dashboard.alchemy.com/api/update-webhook-addresses`,
 * authenticated with the `X-Alchemy-Token` header, with a body of
 * `webhook_id`, `addresses_to_add` ("List of addresses to add (empty array if
 * none)") and `addresses_to_remove` (likewise), answering `200` with an empty
 * object; the docs also state the endpoint is idempotent, which is why a repeated
 * hire or a retry needs no bookkeeping here.
 * Source: https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/update-webhook-addresses
 *
 * The token is the app's Notify AUTH TOKEN, which is a different secret from the
 * per-webhook signing key the deliveries are HMACed with. Alchemy's support page
 * puts it behind the AUTH TOKEN button on the Notify dashboard:
 * https://www.alchemy.com/support/what-is-alchemy-signature-and-where-to-find-the-auth-token
 *
 * Erasable syntax only and no `@nestjs/*` import, so this file stays loadable by
 * a plain `node` script under type stripping (CLAUDE.md gotcha 10) the way the
 * `agents/privy/*` files are. The Nest wiring is in `webhooks.module.ts` and the
 * provider that `AgentsModule` binds.
 */
import { ALCHEMY_NOTIFY_BASE_URL, type AlchemyConfig } from './alchemy.config.ts';

/** DI token for the Notify address list. */
export const ALCHEMY_NOTIFY = Symbol('ALCHEMY_NOTIFY');

export const ALCHEMY_UPDATE_ADDRESSES_PATH = '/update-webhook-addresses';
/** Alchemy's own spelling; node lower-cases it on the way out either way. */
export const ALCHEMY_NOTIFY_AUTH_HEADER = 'X-Alchemy-Token';

export type AlchemyNotifyRefusalReason =
  /** No `ALCHEMY_NOTIFY_AUTH_TOKEN` or no `ALCHEMY_NOTIFY_WEBHOOK_ID`. */
  | 'notify_unconfigured'
  /** The request never completed: DNS, TLS, timeout, connection reset. */
  | 'notify_unreachable'
  /** Alchemy answered, and it was not a 2xx. */
  | 'notify_rejected';

/**
 * A DISCRIMINATED union, the shape `Erc8004Registration` uses, and not
 * `{ ok: boolean; reason?; message? }`: with `ok` typed `boolean` TypeScript
 * never narrows on `if (outcome.ok) return;`, so the caller's warning line in
 * `AgentsService.watchForDeposits` could compile while rendering
 * `undefined (undefined)`. Literal types make both fields provably present on
 * the failure branch.
 */
export type AlchemyNotifyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AlchemyNotifyRefusalReason;
      /** Human detail for the log. Never carries the auth token. */
      readonly message: string;
    };

export interface AlchemyNotifyAddresses {
  /**
   * Starts delivering activity for `address`. NEVER THROWS — every failure comes
   * back as `{ ok: false, reason }`, because the only caller is a hire.
   */
  watchAddress(address: string): Promise<AlchemyNotifyOutcome>;
}

/**
 * Always constructible, even unconfigured — it then refuses every call with
 * `notify_unconfigured` rather than being `undefined`, so a caller has one shape
 * to handle and the warning about an unconfigured webhook is written once, at
 * boot (`describeAlchemyConfig`). There is no `createAlchemyNotify` factory
 * because there is no second implementation to choose between, unlike
 * `createErc8004Client` and `createOpenRouterKeys`.
 */
export class AlchemyNotifyClient implements AlchemyNotifyAddresses {
  /**
   * `typeof fetch` rather than a hand-rolled structural type — the convention in
   * `agents/leaderboard/indexer.ts` and `agents/venues/perpl-agent.ts`. It is
   * what lets the default be `fetch` with no cast.
   */
  constructor(
    private readonly config: AlchemyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async watchAddress(address: string): Promise<AlchemyNotifyOutcome> {
    const { notifyAuthToken, notifyWebhookId } = this.config;
    if (!notifyAuthToken || !notifyWebhookId) {
      return {
        ok: false,
        reason: 'notify_unconfigured',
        message: 'ALCHEMY_NOTIFY_AUTH_TOKEN and ALCHEMY_NOTIFY_WEBHOOK_ID are not both set',
      };
    }
    const url = `${ALCHEMY_NOTIFY_BASE_URL}${ALCHEMY_UPDATE_ADDRESSES_PATH}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'PATCH',
        headers: {
          [ALCHEMY_NOTIFY_AUTH_HEADER]: notifyAuthToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          webhook_id: notifyWebhookId,
          addresses_to_add: [address],
          // Documented as required, "empty array if none".
          addresses_to_remove: [],
        }),
        signal: AbortSignal.timeout(this.config.notifyTimeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'notify_unreachable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!response.ok) {
      // The body can carry Alchemy's reason; it cannot carry our token.
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'notify_rejected',
        message: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      };
    }
    return { ok: true };
  }
}
