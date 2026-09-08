import { Controller, Get } from '@nestjs/common';

import { AuthService } from './auth.service';

/**
 * TODO(MOV-250): stub controller. Routes land with the feature issue.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  describe(): { module: string; implemented: boolean } {
    return this.authService.describe();
  }
}
