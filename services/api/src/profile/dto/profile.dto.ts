import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { AVATAR_SEED_PATTERN } from '../profile-rules';

/**
 * `PATCH /profile`. A field left out is unchanged; `null` resets it to the
 * default the app derives from the address. `IsOptional` lets both through.
 *
 * Only the shape is checked here. The name's real rules (trimmed, 2–24
 * characters, the charset) are `profile-rules.ts`, applied by the service
 * after normalising, so `"  Based   Whale "` is accepted as `"Based Whale"`
 * rather than refused for its spaces. 64 bounds the raw input before that.
 * No `userId`: identity is the session's (`auth/principal.ts`).
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string | null;

  @IsOptional()
  @IsString()
  @Matches(AVATAR_SEED_PATTERN, {
    message: 'avatarSeed must be 1-32 characters of A-Z, a-z, 0-9, _ or -',
  })
  avatarSeed?: string | null;
}

/** `GET /profile` and `PATCH /profile`. `null` = use the default. */
export interface ProfileResponseDto {
  name: string | null;
  avatarSeed: string | null;
}
