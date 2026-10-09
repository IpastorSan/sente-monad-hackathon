import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../auth/principal';
import { CREDITS_CONFIG, type CreditsConfig } from '../credits.config';
import { CreditsRefusedError } from '../credits.errors';
import { FREE_TIER_RESET } from '../credits.service';
import { CREDIT_PAYMENTS, type CreditPayments, type PurchaseReceipt } from './credit-payments';
import {
  AUTO_TOP_UP_OFF,
  checkAutoTopUp,
  checkPurchase,
  creditPlans,
  PURCHASES_CLOSED_NOTE,
  type AutoTopUpSetting,
  type CreditPlansView,
} from './plans';

/** DI token for the purchases flag. */
export const CREDITS_PURCHASE_CONFIG = Symbol('CREDITS_PURCHASE_CONFIG');

export interface CreditsPurchaseConfig {
  /** `CREDITS_PURCHASES_ENABLED`: off unless '1' or 'true', like `USER_TRADING`. */
  readonly purchasesEnabled: boolean;
}

export function loadCreditsPurchaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): CreditsPurchaseConfig {
  const raw = env.CREDITS_PURCHASES_ENABLED?.trim();
  return { purchasesEnabled: raw === '1' || raw === 'true' };
}

/**
 * The plans, a purchase, and the auto top-up setting (SEN-183). With the flag
 * off, every write is refused `purchases_disabled` before its body is read, and
 * the auto top-up reads as off — there is nothing it could have bought.
 */
@Injectable()
export class CreditsPurchaseService {
  constructor(
    @Inject(CREDITS_PURCHASE_CONFIG) private readonly purchaseConfig: CreditsPurchaseConfig,
    @Inject(CREDITS_CONFIG) private readonly credits: CreditsConfig,
    @Inject(CREDIT_PAYMENTS) private readonly payments: CreditPayments,
  ) {}

  plans(): CreditPlansView {
    return creditPlans({
      purchasesEnabled: this.purchaseConfig.purchasesEnabled,
      freeTierUsd: this.credits.defaultLimitUsd,
      freeTierReset: FREE_TIER_RESET,
    });
  }

  async purchase(principal: Principal, body: unknown): Promise<PurchaseReceipt> {
    this.requireOpen();
    const order = checkPurchase(body);
    if (!order.ok) throw new CreditsRefusedError('purchase_invalid', order.message);
    return this.payments.purchase(principal.userId, order.value);
  }

  async autoTopUp(principal: Principal): Promise<AutoTopUpSetting> {
    if (!this.purchaseConfig.purchasesEnabled) return AUTO_TOP_UP_OFF;
    return this.payments.autoTopUp(principal.userId);
  }

  async setAutoTopUp(principal: Principal, body: unknown): Promise<AutoTopUpSetting> {
    this.requireOpen();
    const setting = checkAutoTopUp(body);
    if (!setting.ok) throw new CreditsRefusedError('purchase_invalid', setting.message);
    return this.payments.setAutoTopUp(principal.userId, setting.value);
  }

  private requireOpen(): void {
    if (!this.purchaseConfig.purchasesEnabled) {
      throw new CreditsRefusedError('purchases_disabled', PURCHASES_CLOSED_NOTE);
    }
  }
}
