import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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
