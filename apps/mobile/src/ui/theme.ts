/**
 * "Goban" — Sente's design system, as tokens (SEN-55). The reference is
 * `docs/design/design-system.html`; the values here are the ones it prints.
 *
 * The app is a board: agents place stones, the enclave draws the lines they
 * cannot cross, and Monad purple marks the moment something happens. Four
 * rules hold it together:
 *
 * - Purple is an event. It is on the primary button because pressing it makes
 *   something happen, on a trade because that is a move, and on the consensus
 *   ramp (SEN-24) while a block is landing — and it drains out once the block
 *   is final. Nothing decorative is purple.
 * - A face is a speaker. Bricolage when the app raises its voice, Geist when it
 *   talks, Newsreader italic when the AGENT talks (theses, invalidations, the
 *   mandate read back), Geist Mono when the CHAIN does (hashes, addresses,
 *   block heights). Numbers are always tabular.
 * - Stones say what happened: the ledger's five entry kinds each have a stone
 *   (`Stone` in kit.tsx), so the shape carries the kind.
 * - Limits are drawn, not listed: a mandate limit is a `Gauge` with its cap.
 *
 * `mint` and `berry` are outcome colours, for money that moved; `berry` also
 * marks destructive actions. An enclave refusal is never berry: it is the
 * product working, so it is `purpleSoft`.
 */
import { StyleSheet } from 'react-native';

import { color } from './palette';

// The tokens live in `palette.ts`, RN-free, so pure generators can use them.
export { color } from './palette';

/**
 * Loaded in `app/_layout.tsx`. Each family is one registered face, so styles
 * set `fontFamily` and never `fontWeight` — Android would synthesise a bold.
 */
export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  display: 'BricolageGrotesque_700Bold',
  displaySemibold: 'BricolageGrotesque_600SemiBold',
  voice: 'Newsreader_400Regular_Italic',
  chain: 'GeistMono_400Regular',
} as const;

export const GUTTER = 20;

export const RADIUS = {
  /** Cards and sheets: softly squared boards. */
  board: 20,
  /** Inputs, tiles, sigils. */
  well: 14,
  /** Anything you press is a stone. */
  stone: 999,
} as const;

export const text = StyleSheet.create({
  /** One per screen: the balance that matters. */
  hero: {
    fontFamily: font.displaySemibold,
    fontSize: 52,
    lineHeight: 54,
    letterSpacing: -1.8,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  /** Screen titles. */
  display: {
    fontFamily: font.display,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.8,
    color: color.text,
  },
  /** Sheet and card titles, agent names. */
  title: {
    fontFamily: font.displaySemibold,
    fontSize: 19,
    lineHeight: 24,
    letterSpacing: -0.2,
    color: color.text,
  },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: color.text },
  strong: { fontFamily: font.medium, fontSize: 15, lineHeight: 22, color: color.text },
  dim: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: color.textDim },
  caption: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, color: color.textFaint },
  label: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  /** The agent's own words, and nothing else. */
  voice: { fontFamily: font.voice, fontSize: 17, lineHeight: 24, color: color.purpleSoft },
  /** Chain facts only: hashes, addresses, block heights, policy and agent ids. */
  mono: { fontFamily: font.chain, fontSize: 12, lineHeight: 18, color: color.textDim },
  num: { fontVariant: ['tabular-nums'] },
  up: { color: color.mint },
  down: { color: color.berry },
  danger: { color: color.berry },
});
