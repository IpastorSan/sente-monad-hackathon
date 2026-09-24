/**
 * The raw request body for `POST /webhooks/alchemy`, and ONLY for it — SEN-30.
 *
 * WHY THIS EXISTS. Alchemy signs the bytes it sent (`docs/alchemy.md`, and
 * `alchemy.ts` for the citation), so the HMAC must be computed over those bytes.
 * Nest parses JSON before a controller sees anything, and `JSON.stringify` of the
 * parsed object is NOT the same bytes — key order, whitespace and number
 * formatting all differ — so re-serialising would reject every genuine delivery
 * and, worse, could be made to accept a forged one by an attacker who found a
 * body that round-trips.
 *
 * WHY IT IS MOUNTED IN `main.ts` RATHER THAN IN THE MODULE. Nest registers its
 * body parsers inside `app.init()`, which `listen()` calls; an `app.use()` before
 * that reaches Express FIRST, while middleware configured through a module's
 * `configure(consumer)` runs after the parsers, by which time the stream is
 * consumed and there are no bytes left to hash. One line in `main.ts`, scoped to
 * this path, is therefore the narrow option — narrower than Nest's own
 * `{ rawBody: true }`, which buffers a copy of every request to every route.
 *
 * WHAT STOPS NEST PARSING IT AGAIN, precisely. `@nestjs/platform-express` 12
 * mounts `express.json()`, which is **body-parser 2.3.0**, and body-parser 2
 * begins with `if (onFinished.isFinished(req)) { next(); return }`
 * (`node_modules/body-parser/lib/read.js:39`). This middleware drains the stream
 * to its `end` event, so the request IS finished by then and the JSON parser
 * returns without touching it. It is NOT the `req._body` flag that older guides
 * describe: body-parser 2 deleted that check (`grep -rn _body node_modules/body-parser`
 * finds nothing), which is why this file does not set it and why the spec below
 * asserts the stream is consumed rather than asserting a flag nobody reads.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Mount path. Must match `@Controller('webhooks')` + `@Post('alchemy')`. */
export const ALCHEMY_WEBHOOK_PATH = '/webhooks/alchemy';

/**
 * 1 MiB. An Address Activity delivery is a few hundred bytes per transfer, so
 * this is orders of magnitude of headroom; its job is to stop an unauthenticated
 * caller — the route is public by design — from making us buffer whatever it
 * likes before we have a signature to check.
 */
export const ALCHEMY_WEBHOOK_MAX_BYTES = 1_048_576;

/**
 * Buffers the request body and parks it on `req.rawBody`.
 *
 * The property name matches Nest's own `RawBodyRequest<T>` (`T & { rawBody?: Buffer }`),
 * which is what the controller types the request as, so a later switch to Nest's
 * global `{ rawBody: true }` would need no change at the reading end.
 *
 * Over the size cap it answers 413 itself and never calls `next`, so an oversized
 * body reaches no handler. The body is the same `{statusCode, reason, message}`
 * shape the rest of the API answers with, because nothing downstream of here can
 * render it — Nest's exception filter is past this point.
 */
export function alchemyRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;

  req.on('error', (error) => {
    if (settled) return;
    settled = true;
    next(error);
  });
  req.on('aborted', () => {
    settled = true;
  });
  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > ALCHEMY_WEBHOOK_MAX_BYTES) {
      settled = true;
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          statusCode: 413,
          reason: 'body_too_large',
          message: `an Alchemy delivery may not exceed ${ALCHEMY_WEBHOOK_MAX_BYTES} bytes`,
        }),
      );
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks, size);
    next();
  });
}
