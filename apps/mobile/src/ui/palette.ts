/**
 * The Goban colour tokens on their own, with no React Native import, so pure
 * generators (`avatarArt.ts`) and their node specs can use the real values.
 * `theme.ts` re-exports this as `color`; screens keep importing it from there.
 * The rules for using them are in `theme.ts`.
 */
export const color = {
  /** The ground: Monad's night, not a neutral black. */
  ink: '#0D0A19',
  /** A surface: cards, sheets. A tone step, not an elevation. */
  board: '#15112A',
  /** Inputs, stat tiles, the segmented track. */
  well: '#1D1838',
  line: '#2A2447',
  lineStrong: '#40386A',
  text: '#F3F0FF',
  textDim: '#AAA3CB',
  textFaint: '#6F688F',
  /** Monad purple: primary action, a trade, a block acquiring consensus. */
  purple: '#836EF9',
  /** Purple as text or a glyph on ink, where `purple` is too dark to read. */
  purpleHi: '#A898FF',
  /** Selection, the agent's voice, the enclave's boundary. */
  purpleSoft: '#DDD7FE',
  /** Text on `purpleSoft`. */
  purpleDeep: '#200052',
  mint: '#5FE3B3',
  berry: '#F0508C',
  /** The sheet's backdrop. */
  scrim: 'rgba(6, 4, 14, 0.72)',
} as const;
