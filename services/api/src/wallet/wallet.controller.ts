import { Controller, Get } from '@nestjs/common';

import { WalletService } from './wallet.service';

/**
 * TODO(MOV-250): stub controller. Routes land with the feature issue.
 */
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  describe(): { module: string; implemented: boolean } {
    return this.walletService.describe();
  }
}
