import type { IncomingMessage } from 'node:http';

import { Controller, HttpCode, HttpStatus, Post, Req, type RawBodyRequest } from '@nestjs/common';

import { ALCHEMY_SIGNATURE_HEADER } from './alchemy';
import { WebhooksService, type AlchemyWebhookAck } from './webhooks.service';

/**
 * AUTH: DELIBERATELY NONE. Alchemy is the caller and carries no Sente session,
 * so `SessionAuthGuard` cannot apply — putting it here would reject every
 * genuine delivery. What authenticates the caller instead is the HMAC in
 * `X-Alchemy-Signature` over the raw bytes, which `WebhooksService` checks before
 * it looks at anything in the body. `webhooks.controller.spec.ts` pins the
 * ABSENCE of the guard so that removing the signature check and leaving the route
 * open cannot happen quietly.
 *
 * The route is also listed in `auth/auth.controller.ts`'s inventory of unguarded
 * routes, which is where this repo keeps that list.
 *
 * `RawBodyRequest<IncomingMessage>` is Nest's own type (`T & { rawBody?: Buffer }`),
 * not a local one: `raw-body.ts` parks the bytes under exactly that property
 * name, so switching to Nest's global `{ rawBody: true }` later would need no
 * change here.
 *
 * NO DTO, on purpose. `main.ts` installs a global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, so a
 * class-validator DTO would 400 the first field Alchemy adds to the payload. The
 * handler takes the request itself, and the raw bytes off it: the signature is
 * over those bytes and nothing else can be hashed (see `raw-body.ts`).
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * An Alchemy Notify Address Activity delivery. 200 with `appended` when it
   * produced `deposit` events, 200 with `ignored` when there was nothing to do,
   * 401 when the signature does not verify, 503 when no signing key is
   * configured. Alchemy retries the two error statuses and nothing else.
   */
  @Post('alchemy')
  @HttpCode(HttpStatus.OK)
  async alchemy(@Req() request: RawBodyRequest<IncomingMessage>): Promise<AlchemyWebhookAck> {
    const header = request.headers[ALCHEMY_SIGNATURE_HEADER];
    return this.webhooks.handleAlchemy(
      request.rawBody,
      // Node gives an array only for repeated headers; a repeat is not a
      // signature we should pick from, so only a single value counts.
      typeof header === 'string' ? header : undefined,
    );
  }
}
