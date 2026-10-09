/**
 * Generated names (SEN-172): an adjective and a noun from the trading pit and
 * the zoo — "Based Whale", "Leveraged Ape", "Rekt Otter". Deterministic from
 * the seed (the signer address by default) through the same stream as the
 * avatar, so the name is random but fixed: the same on every device, stored
 * nowhere until the user picks another.
 *
 * The lists are curated: nothing offensive, sexual or drug-flavoured, and no
 * real person. ORDER IS PART OF THE ALGORITHM — a reordered or shortened list
 * renames every user who never chose a name. Append only.
 */
import { pick, seedStream } from '../ui/seed.ts';

export const NAME_ADJECTIVES = [
  'Based',
  'Bullish',
  'Bearish',
  'Leveraged',
  'Diamond',
  'Paper',
  'Rekt',
  'Degen',
  'Giga',
  'Turbo',
  'Hyper',
  'Liquid',
  'Staked',
  'Bridged',
  'Wrapped',
  'Minted',
  'Forked',
  'Pumped',
  'Lunar',
  'Golden',
  'Shiny',
  'Sleepy',
  'Chill',
  'Sneaky',
  'Lucky',
  'Spicy',
  'Frosty',
  'Cosmic',
  'Atomic',
  'Quantum',
  'Gasless',
  'Onchain',
  'Sovereign',
  'Anon',
  'Alpha',
  'Early',
  'Patient',
  'Bonded',
  'Laser',
  'Mega',
  'Parallel',
  'Optimistic',
  'Fearless',
  'Feral',
  'Neon',
  'Volatile',
  'Hedged',
  'Sharded',
] as const;

export const NAME_NOUNS = [
  'Whale',
  'Ape',
  'Gecko',
  'Otter',
  'Shrimp',
  'Crab',
  'Dolphin',
  'Shark',
  'Bull',
  'Bear',
  'Frog',
  'Hamster',
  'Lobster',
  'Penguin',
  'Panda',
  'Fox',
  'Wolf',
  'Owl',
  'Falcon',
  'Raven',
  'Tiger',
  'Llama',
  'Sloth',
  'Koala',
  'Badger',
  'Moose',
  'Yak',
  'Octopus',
  'Squid',
  'Turtle',
  'Narwhal',
  'Walrus',
  'Mantis',
  'Beetle',
  'Rabbit',
  'Pigeon',
  'Goose',
  'Oracle',
  'Validator',
  'Miner',
  'Wizard',
  'Ninja',
  'Ronin',
  'Monk',
  'Sensei',
  'Maxi',
  'Hodler',
  'Farmer',
] as const;

/** "Based Whale": the generated name for `seed`, the same for the same seed, forever. */
export function nameFor(seed: string): string {
  const rand = seedStream(`name:${seed}`);
  const adjective = NAME_ADJECTIVES[pick(rand, NAME_ADJECTIVES.length)]!;
  const noun = NAME_NOUNS[pick(rand, NAME_NOUNS.length)]!;
  return `${adjective} ${noun}`;
}
