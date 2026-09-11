import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { GasDripAuth } from '../gas/auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import { creditsRefusalToHttpException } from './credits.errors';
import { CreditsService, type CreditsView, type ProvisionResult } from './credits.service';

/**
 * AUTH: the same placeholder seam `wallet/` reuses from `gas/` — the principal
 * comes from the guard, never from the request. MOV-251's real session guard
 * replaces both bindings in `credits.module.ts`.
 *
 * SECRETS: every response is built field by field from `CreditsView`, which has
 * no key and no hash, so the plaintext key cannot leak through a spread.
 */
@Controller('credits')
@UseGuards(PlaceholderGasDripAuthGuard)
export class CreditsController {
  constructor(
    private readonly credits: CreditsService,
    private readonly auth: GasDripAuth,
  ) {}

  /** Mints the caller's OpenRouter key. Idempotent: a second call reports the first key. */
  @Post('provision')
  @HttpCode(HttpStatus.OK)
  async provision(): Promise<ProvisionResult> {
    return this.guard(async () => {
      const result = await this.credits.provision(this.auth.principal());
      return { ...toResponse(result), created: result.created };
    });
  }

  /** The caller's limit, what is left of it, and when it resets. */
  @Get()
  async status(): Promise<CreditsView> {
    return this.guard(async () => toResponse(await this.credits.status(this.auth.principal())));
  }

  /** Refusals become a clean 4xx/5xx with a stable `reason`; the rest fall through. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw creditsRefusalToHttpException(error);
    }
  }
}

function toResponse(view: CreditsView): CreditsView {
  return {
    limitUsd: view.limitUsd,
    remainingUsd: view.remainingUsd,
    usageMonthUsd: view.usageMonthUsd,
    resetsAt: view.resetsAt,
  };
}
