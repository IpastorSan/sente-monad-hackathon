import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { formatEther } from 'viem';

import { GasDripAuth } from './auth/gas-drip-auth';
import { PlaceholderGasDripAuthGuard } from './auth/gas-drip-auth.guard';
import { DripRequestDto, type DripResponseDto } from './dto/drip.dto';
import { refusalToHttpException } from './gas.errors';
import { GasDripService, type DripReceipt, type FaucetStatus } from './gas.service';

@Controller('gas')
export class GasController {
  constructor(
    private readonly gasDrip: GasDripService,
    private readonly auth: GasDripAuth,
  ) {}

  /** Unauthenticated faucet status, so the app can hide the button when it is dry. */
  @Get()
  status(): Promise<FaucetStatus> {
    return this.gasDrip.status();
  }

  /**
   * Fund a brand new account with enough MON for a handful of transactions.
   *
   * The caller is whoever the auth guard says they are — `DripRequestDto` has no
   * identity field and `forbidNonWhitelisted` rejects one if added.
   */
  @Post('drip')
  @UseGuards(PlaceholderGasDripAuthGuard)
  @HttpCode(HttpStatus.OK)
  async drip(@Body() body: DripRequestDto, @Ip() ip: string): Promise<DripResponseDto> {
    const principal = this.auth.principal();
    try {
      return toResponse(await this.gasDrip.drip(principal, { address: body.address, ip }));
    } catch (error) {
      // Refusals become a clean 4xx/503 with a stable `reason`; everything else
      // falls through to Nest's default handling.
      throw refusalToHttpException(error);
    }
  }
}

function toResponse(receipt: DripReceipt): DripResponseDto {
  return {
    address: receipt.address,
    amountMon: formatEther(receipt.amountWei),
    // bigint is not JSON-serialisable, so wei crosses the wire as a string.
    amountWei: receipt.amountWei.toString(),
    txHash: receipt.txHash,
    sender: receipt.sender,
    nonce: receipt.nonce,
    dailyTotalMon: formatEther(receipt.dailyTotalWei),
    dailyCapMon: formatEther(receipt.dailyCapWei),
    confirmed: receipt.confirmed,
    dryRun: receipt.dryRun,
  };
}
