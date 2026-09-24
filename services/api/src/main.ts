import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { alchemyRawBody, ALCHEMY_WEBHOOK_PATH } from './webhooks/raw-body';

async function bootstrap(): Promise<void> {
  // SEN-51. Behind Caddy every request arrives from the proxy, so `@Ip()` reads
  // one address for everybody and the drip's per-IP limiter becomes a single
  // shared bucket — several judges in one minute would start refusing each
  // other. Express only believes `X-Forwarded-For` when told how many proxies
  // to trust, and the count must be exact: trust one more hop than exists and a
  // client can spoof its own address by sending the header itself.
  //
  // Read before anything is constructed, so a typo fails the boot rather than
  // silently leaving the limiter blind. Default 0 (off), which is right for a
  // directly reachable API including local development; `infra/docker-compose.yml`
  // sets 1, where Caddy is the only hop and the container is not reachable from
  // anywhere else.
  const rawTrustProxy = process.env.TRUST_PROXY_HOPS ?? '0';
  const trustProxy = Number(rawTrustProxy);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (0 disables it), got "${rawTrustProxy}"`,
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // SEN-30. Registered BEFORE `listen()`, which is what makes it narrow: Nest
  // mounts its own body parsers inside `app.init()`, so this reaches Express
  // first and only for this one path, while every other route keeps the parsed
  // JSON it has today. Alchemy signs the bytes it sent, and a re-serialised body
  // is not those bytes — see `webhooks/raw-body.ts`.
  app.use(ALCHEMY_WEBHOOK_PATH, alchemyRawBody);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // The mobile app is not same-origin with anything, and a native client sends
  // no Origin at all. CORS stays open because it protects browsers, and what
  // protects these routes is the session token `SessionAuthGuard` verifies
  // (SEN-37) — a cross-origin page cannot read a token it was never given.
  app.enableCors({ origin: true });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  Logger.log(`Sente API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
