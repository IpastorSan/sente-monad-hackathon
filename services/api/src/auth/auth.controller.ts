import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { Hex } from 'viem';

import { AuthService, type AuthDescription } from './auth.service';
import {
  ChallengeRequestDto,
  SessionRequestDto,
  type ChallengeResponseDto,
  type SessionResponseDto,
} from './dto/auth.dto';

/**
 * The only routes in the API that are not behind `SessionAuthGuard` besides
 * `GET /health`, `GET /venues` and `GET /gas` — they are how a caller gets a
 * session in the first place, so guarding them would be a closed loop.
 *
 * Neither route is a secret: a challenge is public random bytes, and issuing
 * one to an address the caller does not control produces a nonce nobody can
 * sign. What they do cost is memory, one outstanding challenge per address.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  describe(): AuthDescription {
    return this.authService.describe();
  }

  /** Random nonce plus the exact text to sign. Five minutes, single use. */
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  challenge(@Body() body: ChallengeRequestDto): Promise<ChallengeResponseDto> {
    return this.authService.challenge(body.address);
  }

  /** The signed challenge in, a bearer token out. 401 on anything else. */
  @Post('session')
  @HttpCode(HttpStatus.OK)
  session(@Body() body: SessionRequestDto): Promise<SessionResponseDto> {
    return this.authService.session(body.address, body.signature as Hex);
  }
}
