// What a chosen display name and avatar seed may be (SEN-172).
//
// The app mirrors this in `apps/mobile/src/profile/rules.ts` so its field can
// explain a problem before the round trip, and `rules.test.ts` there runs both
// over the same inputs. This one is the rule that counts. Erasable syntax and
// no imports, because that mobile spec loads it under node's type stripping
// (CLAUDE.md gotcha 10).

export const NAME_MIN = 2;
export const NAME_MAX = 24;

/** Letters and digits in any script, and spaces, dots, apostrophes, hyphens and underscores between them. */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'-]*$/u;

/** Trimmed, with every run of whitespace collapsed to one space. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Why `name` (already normalized) is not acceptable, or `null` when it is. */
export function nameProblem(name: string): string | null {
  const length = [...name].length;
  if (length < NAME_MIN) return `At least ${NAME_MIN} characters.`;
  if (length > NAME_MAX) return `At most ${NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(name)) {
    return "Letters, numbers, spaces and . _ ' - only, starting with a letter or number.";
  }
  return null;
}

/** An avatar re-roll seed: short and URL-safe. */
export const AVATAR_SEED_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
