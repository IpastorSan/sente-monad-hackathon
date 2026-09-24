import { PassThrough } from 'node:stream';
import { createHmac } from 'node:crypto';

import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { IncomingMessage } from 'node:http';

import type { RawBodyRequest } from '@nestjs/common';

import { ALCHEMY_WEBHOOK_MAX_BYTES, ALCHEMY_WEBHOOK_PATH, alchemyRawBody } from './raw-body';
import { WebhooksController } from './webhooks.controller';
import type { AlchemyWebhookAck, WebhooksService } from './webhooks.service';

const SIGNATURE = createHmac('sha256', 'k').update('body').digest('hex');

type Call = { rawBody: Buffer | undefined; signature: string | undefined };

function setup() {
  const calls: Call[] = [];
  const service = {
    handleAlchemy: (rawBody: Buffer | undefined, signature: string | undefined) => {
      calls.push({ rawBody, signature });
      return Promise.resolve<AlchemyWebhookAck>({ received: true, appended: 1 });
    },
  } as unknown as WebhooksService;
  return { calls, controller: new WebhooksController(service) };
}

function request(
  headers: Record<string, string | string[]>,
  rawBody?: Buffer,
): RawBodyRequest<IncomingMessage> {
  return {
    headers,
    ...(rawBody ? { rawBody } : {}),
  } as unknown as RawBodyRequest<IncomingMessage>;
}

describe('WebhooksController', () => {
  it('hands the service the raw bytes and the X-Alchemy-Signature header', async () => {
    const { controller, calls } = setup();
    const body = Buffer.from('{"type":"ADDRESS_ACTIVITY"}');

    await expect(
      controller.alchemy(request({ 'x-alchemy-signature': SIGNATURE }, body)),
    ).resolves.toEqual({ received: true, appended: 1 });

    expect(calls).toEqual([{ rawBody: body, signature: SIGNATURE }]);
  });

  it('passes no signature when the header is absent or repeated', async () => {
    const { controller, calls } = setup();
    const body = Buffer.from('{}');

    await controller.alchemy(request({}, body));
    // Two signatures is not a signature to choose between; it is a refusal.
    await controller.alchemy(request({ 'x-alchemy-signature': [SIGNATURE, 'other'] }, body));

    expect(calls.map((call) => call.signature)).toEqual([undefined, undefined]);
  });

  it('is PUBLIC on purpose — no SessionAuthGuard, because Alchemy carries no session', () => {
    // Pinned so that the guard being absent stays a decision someone made rather
    // than something that drifted. The HMAC is what authenticates this route; if
    // that check is ever removed, this route must not simply be open.
    expect(Reflect.getMetadata(GUARDS_METADATA, WebhooksController)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WebhooksController.prototype.alchemy),
    ).toBeUndefined();
    expect(SessionAuthGuard.name).toBe('SessionAuthGuard');
  });

  it('is mounted where main.ts mounts the raw-body middleware', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WebhooksController)).toBe('webhooks');
    expect(Reflect.getMetadata(PATH_METADATA, WebhooksController.prototype.alchemy)).toBe(
      'alchemy',
    );
    // The one thing that silently breaks the signature check is these two drifting apart.
    expect(ALCHEMY_WEBHOOK_PATH).toBe('/webhooks/alchemy');
  });
});

/** The middleware `main.ts` mounts on that path, which is the only source of `rawBody`. */
describe('alchemyRawBody', () => {
  function run(chunks: (string | Buffer)[]): Promise<{
    req: RawBodyRequest<IncomingMessage>;
    status: number | undefined;
    body: string;
    nexted: boolean;
  }> {
    const req = new PassThrough() as unknown as RawBodyRequest<IncomingMessage>;
    let status: number | undefined;
    let body = '';
    const res = {
      set statusCode(value: number) {
        status = value;
      },
      setHeader: () => undefined,
      end: (chunk?: string) => {
        body = chunk ?? '';
      },
    } as unknown as Parameters<typeof alchemyRawBody>[1];

    return new Promise((resolve) => {
      let nexted = false;
      alchemyRawBody(req, res, () => {
        nexted = true;
      });
      for (const chunk of chunks) (req as unknown as PassThrough).write(chunk);
      (req as unknown as PassThrough).end();
      setImmediate(() => resolve({ req, status, body, nexted }));
    });
  }

  it('parks the exact bytes on rawBody, reassembled across chunks', async () => {
    const { req, nexted } = await run(['{"a":', '1}']);
    expect(nexted).toBe(true);
    expect(req.rawBody?.toString('utf8')).toBe('{"a":1}');
  });

  it('drains the stream, which is what stops body-parser reading it again', async () => {
    // body-parser 2.3.0 guards with `onFinished.isFinished(req)` (lib/read.js:39),
    // NOT with the `req._body` flag older guides describe — `grep -rn _body
    // node_modules/body-parser` finds nothing. So the invariant that matters is
    // that the request is ended, not that a flag is set.
    const { req } = await run(['{}']);
    expect((req as unknown as { readableEnded: boolean }).readableEnded).toBe(true);
  });

  it('answers 413 with the API’s error shape, and reaches no handler', async () => {
    const { status, body, nexted } = await run([Buffer.alloc(ALCHEMY_WEBHOOK_MAX_BYTES + 1, 0x61)]);
    expect(status).toBe(413);
    expect(nexted).toBe(false);
    // Nest's exception filter is upstream of this middleware, so it renders the
    // same {statusCode, reason, message} shape the rest of the API answers with.
    expect(JSON.parse(body)).toMatchObject({ statusCode: 413, reason: 'body_too_large' });
  });

  it('leaves an empty body as an empty buffer, not undefined', async () => {
    const { req } = await run([]);
    expect(req.rawBody).toEqual(Buffer.alloc(0));
  });
});
