import { IsEthereumAddress, IsString } from 'class-validator';

/**
 * The ONLY field a caller may supply. There is deliberately no `userId` here:
 * identity comes from the auth context (see `auth/principal.ts`), and the
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a request that
 * tries to smuggle one in is rejected with a 400 rather than ignored.
 */
export class DripRequestDto {
  @IsString()
  @IsEthereumAddress()
  address!: string;
}

export interface DripResponseDto {
  address: string;
  /** Decimal MON, e.g. "0.1". */
  amountMon: string;
  amountWei: string;
  txHash: string;
  /** Which rotating faucet key paid, and with which nonce. */
  sender: string;
  nonce: number;
  dailyTotalMon: string;
  dailyCapMon: string;
  /**
   * True once the receipt is in. False when it did not arrive in time; the
   * drip is still counted as spent and is never re-sent — follow `txHash`.
   */
  confirmed: boolean;
  /** True when nothing was broadcast (GAS_DRIP_DRY_RUN). */
  dryRun: boolean;
}
