import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { creditsRefusalToHttpException } from './credits.errors';
import { CreditsService, type CreditsView, type ProvisionResult } from './credits.service';
import type { PurchaseReceipt } from './purchase/credit-payments';
import { CreditsPurchaseService } from './purchase/credits-purchase.service';
import type { AutoTopUpSetting, CreditPlansView } from './purchase/plans';

/**
 * AUTH: the same seam `wallet/` uses — the principal comes from the session
 * `SessionAuthGuard` verified, never from the request.
 *
 * SECRETS: every response is built field by field from `CreditsView`, which has
 * no key and no hash, so the plaintext key cannot leak through a spread.
 *
 * `GET /credits` itself lives in `usage/credits-overview.controller.ts`
 * (SEN-183): it reads the agents' run transcripts, which this module cannot
 * import without a cycle (`AgentsModule` imports it).
 */
@Controller('credits')
@UseGuards(SessionAuthGuard)
export class CreditsController {
  constructor(
    private readonly credits: CreditsService,
    private readonly purchases: CreditsPurchaseService,
    private readonly auth: Auth,
  ) {}

  /** Mints the caller's OpenRouter key. Idempotent: a second call reports the first key. */
  @Post('provision')
  @HttpCode(HttpStatus.OK)
  async provision(): Promise<ProvisionResult> {
    return guard(async () => {
      const result = await this.credits.provision(this.auth.principal());
      return { ...toResponse(result), created: result.created };
    });
  }

  /** The packs, the custom range, the auto top-up options, and whether buying is open. */
  @Get('plans')
  plans(): CreditPlansView {
    return this.purchases.plans();
  }

  /** `{plan: 'pack_20'}` or `{plan: 'custom', amountUsd}`. 403 `purchases_disabled` while the flag is off. */
  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  async purchase(@Body() body: unknown): Promise<PurchaseReceipt> {
    return guard(() => this.purchases.purchase(this.auth.principal(), body));
  }

  @Get('auto-top-up')
  async autoTopUp(): Promise<AutoTopUpSetting> {
    return guard(() => this.purchases.autoTopUp(this.auth.principal()));
  }

  /** `{enabled: false}` or `{enabled: true, thresholdUsd, amountUsd}`. Refused like a purchase. */
  @Put('auto-top-up')
  async setAutoTopUp(@Body() body: unknown): Promise<AutoTopUpSetting> {
    return guard(() => this.purchases.setAutoTopUp(this.auth.principal(), body));
  }
}

/** Refusals become a clean 4xx/5xx with a stable `reason`; the rest fall through. */
export async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw creditsRefusalToHttpException(error);
  }
}

export function toResponse(view: CreditsView): CreditsView {
  return {
    limitUsd: view.limitUsd,
    remainingUsd: view.remainingUsd,
    usageMonthUsd: view.usageMonthUsd,
    resetsAt: view.resetsAt,
  };
}
