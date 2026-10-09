/**
 * The wire shapes of `/trade` (SEN-96, plan M-T14, "Shared wire types").
 *
 * The request classes are validated by the global ValidationPipe
 * (`whitelist`, `forbidNonWhitelisted`, `transform`); the response types are
 * plain interfaces, because the controller builds them and nothing parses
 * them here. `apps/mobile/src/trade/api.ts` (M-T20) copies the response types
 * verbatim — change one and change the other.
 *
 * Like the wallet DTOs, nothing here carries a `userId`: identity is the
 * session subject, and `forbidNonWhitelisted` turns a smuggled one into a 400.
 */

import type { AuthorizationPayload } from '@sente/mandate';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEthereumAddress,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Address, Hex } from 'viem';

import type { KuruPlaceResult, StepKind, StepStatus, TradeFunds, TradeKind } from '../trade-store';

export const TRADE_KINDS = [
  'kuru.place',
  'kuru.cancel',
  'kuru.withdraw',
  'perpl.onboard',
] as const satisfies readonly TradeKind[];

/** A non-negative integer as a decimal string: atoms, units, never a decimal-shifted figure. */
const ATOMS = /^[0-9]{1,78}$/;
/** Kuru's `"<slot>:<orderId>"` (plan "Shared wire types"). */
const KURU_ORDER_ID = /^[0-9]{1,78}:[0-9]{1,78}$/;
/** Base64, as a DER ECDSA P-256 signature from the device key crosses (see `ExecuteSendDto`). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The most steps a trade can have: `[approve, deposit, place]`. Room for Perpl's three, too. */
export const MAX_TRADE_STEPS = 8;

const is =
  (...kinds: TradeKind[]) =>
  (body: TradeIntentDto): boolean =>
    kinds.includes(body.kind);

/**
 * `POST /trade/prepare` — the plan's `TradeIntent` union, as one class.
 *
 * class-validator has no discriminated unions, so every variant's fields are
 * declared here and each is validated only for the kinds that own it
 * (`ValidateIf`). A field that belongs to another kind passes unchecked, and
 * that is harmless: the service rebuilds the intent from the kind's own fields
 * (`toTradeIntent`) and never reads the rest — so a stray field can neither
 * reach the planner nor change the intent hash.
 *
 * Only shape is checked here. What the numbers mean (on tick, above the
 * minimum, affordable) is the planner's to judge against the chain.
 */
export class TradeIntentDto {
  @IsIn(TRADE_KINDS)
  kind!: TradeKind;

  /**
   * Phone-generated UUID v4. It names the trade for idempotency and is part of
   * every step's signed `privy-idempotency-key`, and `keccak256` of it is the
   * order's `clientOrderId` — so it must be exactly what the phone will check.
   */
  @IsUUID('4')
  clientTradeId!: string;

  /** kuru.place, kuru.cancel: the OrderBook. */
  @ValidateIf(is('kuru.place', 'kuru.cancel'))
  @IsEthereumAddress()
  market?: string;

  @ValidateIf(is('kuru.place'))
  @IsIn(['buy', 'sell'])
  side?: 'buy' | 'sell';

  @ValidateIf(is('kuru.place'))
  @IsIn(['market', 'limit'])
  orderType?: 'market' | 'limit';

  /** Book size units. */
  @ValidateIf(is('kuru.place'))
  @Matches(ATOMS, { message: 'sizeAtoms must be a whole number as a decimal string' })
  sizeAtoms?: string;

  /** The limit price, or the phone-computed worst price for a market order. */
  @ValidateIf(is('kuru.place'))
  @Matches(ATOMS, { message: 'priceUnits must be a whole number as a decimal string' })
  priceUnits?: string;

  @IsOptional()
  @IsBoolean()
  postOnly?: boolean;

  /** The phone-computed cap for the funding leg, in the funding token's atoms. */
  @ValidateIf(is('kuru.place'))
  @Matches(ATOMS, { message: 'maxDepositAtoms must be a whole number as a decimal string' })
  maxDepositAtoms?: string;

  /** kuru.cancel: `"<slot>:<orderId>"`. */
  @ValidateIf(is('kuru.cancel'))
  @Matches(KURU_ORDER_ID, { message: 'orderId must be "<slot>:<orderId>"' })
  orderId?: string;

  /** kuru.withdraw: the token, or the zero address for native MON. */
  @ValidateIf(is('kuru.withdraw'))
  @IsEthereumAddress()
  token?: string;

  /** kuru.withdraw, perpl.onboard. */
  @ValidateIf(is('kuru.withdraw', 'perpl.onboard'))
  @Matches(ATOMS, { message: 'amountAtoms must be a whole number as a decimal string' })
  amountAtoms?: string;
}

/** `POST /trade/:tradeId/commit`. */
export class CommitTradeDto {
  /**
   * One device-key signature per step, by step index, each over that step's
   * `payload`. Forwarded to Privy verbatim; Privy is the one that checks them.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRADE_STEPS)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @Matches(BASE64, { each: true, message: 'each signature must be base64 (DER ECDSA P-256)' })
  signatures!: string[];
}

export class TradeIdParamDto {
  /** The server's trade id (`PreparedTrade.tradeId`), never the client's. */
  @IsUUID('4')
  tradeId!: string;
}

export class ListTradesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * `GET /trade/capabilities`. Always the full shape, flag on or off, so the app
 * has one type to read; with the flag off every boolean is false.
 */
export interface TradeCapabilitiesDto {
  enabled: boolean;
  atomicBatch: boolean;
  chainId: number;
  /** `perpl` is `USER_TRADING_PERPL`, and false whenever `enabled` is. */
  venues: { kuru: boolean; perpl: boolean };
}

/**
 * `GET /trade/perpl/account` (SEN-99): what onboarding still needs. Amounts
 * are AUSD atoms. `apiKey` (the phone's trade-key token, absent until
 * enrollment) and `readKey: 'linked'` come from enrollment (M-T18, SEN-174).
 */
export interface PerplAccountDto {
  accountId: string | null;
  /** Known to be on. False also when unknown: re-allowing it is harmless. */
  forwarding: boolean;
  minOpenAtoms: string;
  apiKey?: string;
  readKey: 'linked' | 'unlinked';
}

export interface PreparedStepDto {
  index: number;
  kind: StepKind;
  title: string;
  /**
   * What the device key signs, exactly as Privy will check it. The phone
   * verifies it against the intent before signing — never the title.
   */
  payload: AuthorizationPayload;
}

/** `POST /trade/prepare`. */
export interface PreparedTradeDto {
  tradeId: string;
  clientTradeId: string;
  /** ISO 8601. Commit before this or prepare again. */
  expiresAt: string;
  wallet: { walletId: string; address: Address };
  steps: PreparedStepDto[];
  /** Render only; the phone decides from `payload`. */
  summary: Record<string, string>;
}

export interface TradeStepViewDto {
  index: number;
  kind: StepKind;
  title: string;
  status: StepStatus;
  userOpHash?: Hex;
  transactionHash?: Hex;
  blockNumber?: string;
  error?: string;
}

/** `POST /trade/:tradeId/commit`, `GET /trade/:tradeId`, `GET /trade`. */
export interface TradeViewDto {
  tradeId: string;
  clientTradeId: string;
  kind: TradeKind;
  status: 'prepared' | 'executing' | 'completed' | 'failed' | 'expired';
  steps: TradeStepViewDto[];
  result?: KuruPlaceResult;
  funds?: TradeFunds;
  /** ISO 8601. */
  updatedAt: string;
}
