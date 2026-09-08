import { Module } from '@nestjs/common';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * TODO(MOV-250): stub module. Smart-account creation and ERC-4337 UserOperation submission via Pimlico.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
