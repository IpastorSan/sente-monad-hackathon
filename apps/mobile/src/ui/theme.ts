/**
 * "Instrument Grey" — the plan's design direction, as tokens.
 *
 * Achromatic ground, colour only where it carries information. Hairline
 * rules instead of cards: no glass, no blur, no elevation, no large radii.
 * Inter everywhere, with tabular figures for numbers; true mono is reserved
 * for chain facts (addresses, ids), so mono means "this came from the chain".
 *
 * Two chromatic tokens, and no more. `ramp` is Monad's purple, and it belongs
 * to the consensus ramp (SEN-24) and to nothing else — it marks a chain event
 * in progress, and it leaves the screen when the event is over. `danger` is
 * for destructive actions and errors, because those carry information too.
 * Everything else is grey, on purpose.
 */
import { StyleSheet } from 'react-native';

export const color = {
  ground: '#0B0B0C',
  /** A tone step for the sheet, not an elevation. */
  raised: '#111112',
  rule: '#232326',
  ruleStrong: '#3A3A3E',
  text: '#EDEDED',
  textDim: '#A0A0A5',
  textFaint: '#67676C',
  danger: '#E5534B',
  /**
   * Monad's purple. The consensus ramp's own colour: a block acquiring
   * consensus fills in it, and the fill drains back to neutral once the block
   * is final, so the purple is an event rather than a state.
   */
  ramp: '#836EF9',
} as const;

export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  mono: 'monospace',
} as const;

export const GUTTER = 20;
export const RADIUS = 2;

export const text = StyleSheet.create({
  display: {
    fontFamily: font.semibold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.6,
    color: color.text,
  },
  title: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: color.text },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: color.text },
  strong: { fontFamily: font.medium, fontSize: 15, lineHeight: 21, color: color.text },
  dim: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: color.textDim },
  caption: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: color.textFaint },
  label: {
    fontFamily: font.medium,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: color.textFaint,
  },
  /** Chain facts only: addresses, ids, tokens. */
  mono: { fontFamily: font.mono, fontSize: 12.5, lineHeight: 18, color: color.textDim },
  num: { fontVariant: ['tabular-nums'] },
  danger: { color: color.danger },
});
