import { Module } from '@nestjs/common';

import { GasController } from './gas.controller';
import { GasService } from './gas.service';

/**
 * TODO(MOV-250): stub module. Testnet MON drip for new accounts, rotating over GAS_DRIP_PRIVATE_KEYS.
 */
@Module({
  controllers: [GasController],
  providers: [GasService],
  exports: [GasService],
})
export class GasModule {}
