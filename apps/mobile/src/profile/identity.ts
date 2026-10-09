/**
 * Who the user looks like (SEN-172): the overrides from `/profile` laid over
 * the defaults derived from the signer address. Pure, so the specs run under
 * plain node; `useProfile` only holds the state.
 *
 * Avatar re-rolls are a counter, not random strings: re-roll steps it up,
 * "previous" steps it down, and reset clears it. The face drawn is
 * `address` for the default and `address/n` for the n-th re-roll, so a
 * counter is the user's own sequence and two users at "3" look nothing alike.
 */
import type { Profile } from './api.ts';
import { nameFor } from './names.ts';

export type Identity = {
  /** What the header says. */
  readonly name: string;
  /** The seed the avatar is drawn from. */
  readonly avatarSeed: string;
  readonly defaultName: boolean;
  readonly defaultAvatar: boolean;
  /** The re-roll counter, 0 for the default face. */
  readonly avatarStep: number;
};

/** The address as a seed: lowercase, so a checksummed and a plain address are one face. */
function base(address: string): string {
  return address.toLowerCase();
}

/** The avatar counter a stored seed means; anything that is not one reads as 0. */
export function avatarStepOf(seed: string | null): number {
  if (seed === null || !/^[1-9][0-9]{0,8}$/.test(seed)) return 0;
  return Number(seed);
}

/** The stored seed for counter `step`: `null` at 0, which is the default. */
export function avatarSeedFor(step: number): string | null {
  return step <= 0 ? null : String(step);
}

export function identityOf(address: string, profile: Profile): Identity {
  const step = avatarStepOf(profile.avatarSeed);
  return {
    name: profile.name ?? nameFor(base(address)),
    // A seed that is not a counter (written by a later client) is still that face.
    avatarSeed:
      profile.avatarSeed === null ? base(address) : `${base(address)}/${profile.avatarSeed}`,
    defaultName: profile.name === null,
    defaultAvatar: profile.avatarSeed === null,
    avatarStep: step,
  };
}

/**
 * A fresh generated name for "roll a name": the `n`-th alternative for this
 * address, skipping any that equal `current`.
 */
export function rolledName(address: string, n: number, current: string): string {
  for (let i = n; i < n + 8; i++) {
    const name = nameFor(`${base(address)}/name/${i}`);
    if (name !== current) return name;
  }
  return nameFor(`${base(address)}/name/${n}`);
}
