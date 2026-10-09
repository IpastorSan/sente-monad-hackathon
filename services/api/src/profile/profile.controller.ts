import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { UpdateProfileDto, type ProfileResponseDto } from './dto/profile.dto';
import { ProfileService } from './profile.service';

/**
 * `GET /profile` and `PATCH /profile` (SEN-172): the caller's own name and
 * avatar overrides, `null` for "use the default". Identity is the session's,
 * as everywhere: there is no way to read or write someone else's.
 */
@Controller('profile')
@UseGuards(SessionAuthGuard)
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly auth: Auth,
  ) {}

  @Get()
  get(): ProfileResponseDto {
    return this.profiles.get(this.auth.principal());
  }

  @Patch()
  update(@Body() body: UpdateProfileDto): ProfileResponseDto {
    return this.profiles.update(this.auth.principal(), body);
  }
}
