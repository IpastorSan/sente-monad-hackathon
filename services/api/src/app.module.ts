import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AgentsModule } from './agents/agents.module';
import { AuthModule } from './auth/auth.module';
import { CreditsModule } from './credits/credits.module';
import { GasModule } from './gas/gas.module';
import { HealthModule } from './health/health.module';
import { VenuesModule } from './venues/venues.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Secrets live in a single .env at the repo root; see .env.example.
      envFilePath: ['../../.env', '.env'],
    }),
    HealthModule,
    AuthModule,
    WalletModule,
    VenuesModule,
    AgentsModule,
    CreditsModule,
    GasModule,
  ],
})
export class AppModule {}
