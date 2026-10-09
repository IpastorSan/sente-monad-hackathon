/**
 * THE PAYMENT SEAM (SEN-183). Nothing is bound to it yet: the testnet demo
 * runs on the free tier, and `CREDITS_PURCHASES_ENABLED` is off.
 *
 * The rail it is shaped for (docs/openrouter.md, "Buying credits"):
 *
 * 1. The app sends `usd` of USDC or AUSD from the user's Privy wallet to the
 *    treasury, as a sponsored send (`wallet/send/sponsored-send.ts`), and
 *    hands the API the UserOperation hash.
 * 2. The API confirms it from the bundler's UserOperation receipt — `success`
 *    on the operation, never the carrying transaction's status (CLAUDE.md
 *    gotcha 8) — and checks token, amount, sender and recipient from the
 *    Transfer log.
 * 3. Only then does it raise the user's OpenRouter key limit by `usd` through
 *    the management API (`OpenRouterKeyApi.updateKey`), keyed by the
 *    UserOperation hash so a retried confirmation never credits twice.
 *
 * Auto top-up is the same three steps, started by the server when the
 * remaining balance falls under the threshold. That needs a standing
 * authorisation to move the user's funds — a Privy policy rule scoped to the
 * treasury and a monthly cap — which is the real work, and is not designed yet.
 */
import { CreditsRefusedError } from '../credits.errors';
import type { AutoTopUpSetting, PurchaseOrder } from './plans';

/** DI token for the payment rail. */
export const CREDIT_PAYMENTS = Symbol('CREDIT_PAYMENTS');

export interface PurchaseReceipt {
  readonly plan: PurchaseOrder['plan'];
  readonly usd: number;
  /** The key's limit after the raise. */
  readonly limitUsd: number;
}

export interface CreditPayments {
  purchase(userId: string, order: PurchaseOrder): Promise<PurchaseReceipt>;
  autoTopUp(userId: string): Promise<AutoTopUpSetting>;
  setAutoTopUp(userId: string, setting: AutoTopUpSetting): Promise<AutoTopUpSetting>;
}

/** What is bound today. Reached only with purchases switched on, and says so. */
export class NoCreditPayments implements CreditPayments {
  purchase(): Promise<PurchaseReceipt> {
    return Promise.reject(unavailable());
  }
  autoTopUp(): Promise<AutoTopUpSetting> {
    return Promise.reject(unavailable());
  }
  setAutoTopUp(): Promise<AutoTopUpSetting> {
    return Promise.reject(unavailable());
  }
}

function unavailable(): CreditsRefusedError {
  return new CreditsRefusedError(
    'payments_unavailable',
    'CREDITS_PURCHASES_ENABLED is on, but no payment rail is bound on this server',
  );
}
