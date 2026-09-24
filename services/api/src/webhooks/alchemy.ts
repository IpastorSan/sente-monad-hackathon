/**
 * Alchemy Notify deliveries: the signature over the raw body, the
 * Address Activity payload, and the `deposit` event one transfer becomes — SEN-30.
 *
 * NOTHING HERE IS INVENTED. Every field name and the whole signature scheme are
 * taken from Alchemy's current documentation, cited inline so a future reader can
 * re-check them rather than trust this file:
 *
 * - SIGNATURE. Header `X-Alchemy-Signature`; the value is the hex HMAC-SHA256 of
 *   the request body keyed by that webhook's signing key, and the docs are
 *   explicit that it "must be raw string body, not json transformed version of
 *   the body". Their own sample is
 *   `crypto.createHmac("sha256", signingKey).update(body, "utf8").digest("hex")`.
 *   Source: "Webhooks Quickstart",
 *   https://www.alchemy.com/docs/reference/notify-api-quickstart
 *
 * - PAYLOAD. `webhookId`, `id`, `createdAt`, `type: "ADDRESS_ACTIVITY"`,
 *   `event.network`, `event.activity[]` with `fromAddress`, `toAddress`,
 *   `blockNum` (hex), `hash`, `value` (a NUMBER, already decimal-converted by
 *   Alchemy), `asset`, `category`, `rawContract.{rawValue,address,decimals}`,
 *   and an optional `log`. `activity` is documented as the "List of transfer
 *   events whose `from` or `to` address matches the address configured".
 *   Source: "Address Activity Webhook",
 *   https://www.alchemy.com/docs/reference/address-activity-webhook
 *
 * WHY THE VALIDATION IS HAND-ROLLED. `services/api` uses no schema library in
 * `src/` (zod appears only in dependencies), and this is the only untrusted JSON
 * the API parses, so it validates field by field rather than importing a habit
 * the rest of the tree does not have.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lower-cased: node normalises incoming header names, so lookups must match. */
export const ALCHEMY_SIGNATURE_HEADER = 'x-alchemy-signature';

/** Hex HMAC-SHA256: 32 bytes, 64 hex characters. */
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * True when `signature` is the HMAC-SHA256 of exactly these bytes under
 * `signingKey`.
 *
 * The HMAC is taken over the Buffer rather than over `body.toString('utf8')` as
 * the docs' sample does. That is the same bytes for any valid UTF-8 body — which
 * JSON always is — and it cannot be wrong: a round trip through a JS string
 * would replace any byte sequence node could not decode, and then the digest
 * would be of something Alchemy never sent.
 *
 * Constant time, and length-checked first, because `timingSafeEqual` throws on
 * mismatched lengths. A signature that is not 64 hex characters is refused
 * outright: `Buffer.from('zz', 'hex')` silently returns an EMPTY buffer, so
 * parsing it first and comparing after would make garbage compare equal to
 * garbage.
 */
export function verifyAlchemySignature(
  body: Buffer,
  signature: string | undefined,
  signingKey: string,
): boolean {
  if (!signature || !HEX_SHA256.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(body).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface AlchemyRawContract {
  readonly rawValue?: string;
  readonly address?: string;
  readonly decimals?: number;
}

export interface AlchemyActivity {
  readonly fromAddress: string;
  readonly toAddress: string;
  /** Hex, e.g. `0xdf34a3`. */
  readonly blockNum: string;
  readonly hash: string;
  /** Already converted by Alchemy; absent on an NFT transfer. */
  readonly value?: number;
  /** A token symbol, or the chain's native symbol. */
  readonly asset?: string;
  /**
   * `external` (an EOA transaction), `internal` (a contract-to-contract value
   * transfer) or one of the token families. Left as `string` because the parser
   * is deliberately tolerant of values Alchemy adds later.
   *
   * `internal` is documented as supported on Ethereum, Polygon, Arbitrum,
   * Optimism, Base, BNB, Avalanche, Robinhood and Arc — **Monad is not in that
   * list** — and the Monad Testnet page separately says the Transfers API is
   * unavailable there. So on Monad expect `external` and the token categories
   * only, and a deposit made by a contract call may produce no delivery at all.
   * Same sources as the payload above; `docs/alchemy.md` step 6 is the
   * measurement that settles it.
   */
  readonly category?: string;
  readonly rawContract?: AlchemyRawContract;
}

export interface AlchemyAddressActivity {
  readonly webhookId: string;
  /** Alchemy's id for this DELIVERY. Stable across its retries. */
  readonly id: string;
  readonly createdAt: string;
  readonly type: string;
  readonly event: {
    readonly network?: string;
    readonly activity: readonly AlchemyActivity[];
  };
}

const ALCHEMY_ADDRESS_ACTIVITY_TYPE = 'ADDRESS_ACTIVITY';

/**
 * Raw bytes -> a delivery we are willing to act on, or a reason we are not.
 *
 * Deliberately tolerant about fields we do not use and strict about the five we
 * do (`id`, `type`, `activity[].toAddress`, `.hash`, `.blockNum`): Alchemy adds
 * fields to this payload over time, and a parser that rejected an unknown one
 * would break on their schedule rather than ours.
 */
export type AlchemyParse =
  | { readonly ok: true; readonly payload: AlchemyAddressActivity }
  | { readonly ok: false; readonly reason: 'body_not_json' | 'not_address_activity' };

export function parseAlchemyAddressActivity(body: Buffer): AlchemyParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body_not_json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'body_not_json' };
  const { id, type, event } = parsed;
  if (typeof id !== 'string' || id === '') return { ok: false, reason: 'not_address_activity' };
  if (type !== ALCHEMY_ADDRESS_ACTIVITY_TYPE) {
    return { ok: false, reason: 'not_address_activity' };
  }
  if (!isRecord(event) || !Array.isArray(event.activity)) {
    return { ok: false, reason: 'not_address_activity' };
  }
  const activity = event.activity.filter(isActivity);
  return {
    ok: true,
    payload: {
      webhookId: typeof parsed.webhookId === 'string' ? parsed.webhookId : '',
      id,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      type,
      event: {
        network: typeof event.network === 'string' ? event.network : undefined,
        activity,
      },
    },
  };
}

/**
 * The `detail` of the `deposit` event one transfer becomes. JSON-safe by
 * construction — every number is a number and every amount a string, because
 * `value` is a float Alchemy already scaled and `rawValue` is the exact integer.
 *
 * `amount` is the human figure (what the Ledger shows) and `rawAmount` the hex
 * word from the log, so nothing downstream has to trust a float to reconstruct
 * the exact quantity.
 */
// A `type`, not an `interface`, and that is load-bearing: `AgentEvent.detail` is
// `Readonly<Record<string, unknown>>`, and TypeScript grants an implicit index
// signature to an object TYPE alias but never to an interface. An interface here
// would need a cast at the append site.
export type AgentDepositDetail = {
  readonly asset: string;
  readonly amount: string;
  readonly rawAmount?: string;
  readonly from: string;
  readonly to: string;
  readonly tokenAddress?: string;
  readonly decimals?: number;
  readonly blockNumber: number;
  readonly txHash: string;
  readonly category?: string;
  readonly network?: string;
  /** Alchemy's delivery id, so a Ledger row can be traced back to a delivery. */
  readonly deliveryId: string;
  /** What `WebhooksService` deduplicates on; see `depositKey`. */
  readonly dedupeKey: string;
};

/**
 * The identity of a transfer, for idempotency.
 *
 * `index` is the transfer's position in `event.activity`, which is what makes
 * this stable under Alchemy's retries — a retry re-sends the SAME payload, so
 * the same transfer sits at the same index — while still telling two otherwise
 * identical transfers in one transaction apart.
 *
 * The residual case, stated rather than hidden: the same transfer arriving under
 * a DIFFERENT delivery id at a different index (an address removed from the
 * webhook and added back, say) would not be recognised. That needs a log index,
 * and Alchemy's documented `log` object does not carry one.
 */
export function depositKey(activity: AlchemyActivity, index: number): string {
  const amount = activity.rawContract?.rawValue ?? String(activity.value ?? '');
  return [activity.hash, index, activity.toAddress.toLowerCase(), amount].join(':');
}

/** The asset symbol to record when Alchemy sends none. */
const UNKNOWN_ASSET = 'unknown';

/**
 * One activity entry -> the `deposit` detail, or `undefined` when its block
 * number is not readable. `payload` is here only for `deliveryId` and `network`,
 * `index` only for the key — the entry itself is passed in, so nothing has to
 * re-index the array and nothing has to guard a hole that cannot exist.
 */
export function toDepositDetail(
  payload: AlchemyAddressActivity,
  activity: AlchemyActivity,
  index: number,
): AgentDepositDetail | undefined {
  const blockNumber = Number.parseInt(activity.blockNum, 16);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) return undefined;
  return {
    asset: activity.asset?.trim() || UNKNOWN_ASSET,
    // `value` is Alchemy's already-scaled number; `String` keeps it exactly as
    // JSON carried it and off the wire as a float.
    amount: activity.value === undefined ? '0' : String(activity.value),
    ...(activity.rawContract?.rawValue !== undefined
      ? { rawAmount: activity.rawContract.rawValue }
      : {}),
    from: activity.fromAddress,
    to: activity.toAddress,
    ...(activity.rawContract?.address !== undefined
      ? { tokenAddress: activity.rawContract.address }
      : {}),
    ...(activity.rawContract?.decimals !== undefined
      ? { decimals: activity.rawContract.decimals }
      : {}),
    blockNumber,
    txHash: activity.hash,
    ...(activity.category !== undefined ? { category: activity.category } : {}),
    ...(payload.event.network !== undefined ? { network: payload.event.network } : {}),
    deliveryId: payload.id,
    dedupeKey: depositKey(activity, index),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActivity(value: unknown): value is AlchemyActivity {
  if (!isRecord(value)) return false;
  return (
    typeof value.toAddress === 'string' &&
    typeof value.fromAddress === 'string' &&
    typeof value.hash === 'string' &&
    typeof value.blockNum === 'string'
  );
}
