/**
 * The icon set's path data (SEN-55): 24-unit SVG paths, drawn at a 1.8 stroke
 * with round caps and joins. Shared by both renderers — Skia on native
 * (`icons.tsx`) and DOM SVG on web (`icons.web.tsx`, SEN-173) — so the two can
 * never draw different glyphs. Pure, so `iconPaths.test.ts` runs under node.
 */

export const PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  agents:
    'M12 9a4 4 0 1 1-8 0a4 4 0 1 1 8 0M20 9a4 4 0 1 1-8 0a4 4 0 1 1 8 0M16 16a4 4 0 1 1-8 0a4 4 0 1 1 8 0',
  board: 'M5 20v-8M12 20V4M19 20v-5',
  account: 'M16 8a4 4 0 1 1-8 0a4 4 0 1 1 8 0M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  key: 'M12 15a4 4 0 1 1-8 0a4 4 0 1 1 8 0M11 12l9-9M16 7l3 3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  check: 'M5 12l5 5 9-10',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  return: 'M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10h-3',
  stop: 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0M5.6 5.6l12.8 12.8',
  copy: 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  share: 'M12 15V3M7 8l5-5 5 5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6',
  // The trading dock (SEN-109), from `docs/design/trading/icons.svg`.
  markets: 'M3 17l5-6 4 4 8-9M15 6h5v5',
  portfolio: 'M12 3a9 9 0 1 0 9 9h-9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  trade: 'M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4',
  // Home's alerts bell (SEN-156), same source.
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  // The Portfolio tab's hide-balances toggle (SEN-118), same source.
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  eyeOff:
    'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6',
  // Home's hide-balances toggle (SEN-113): the study's lens-shaped eye, and the
  // same eye struck through.
  balances: 'M2 12Q12 1 22 12Q12 23 2 12zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  balancesHidden: 'M2 12Q12 1 22 12Q12 23 2 12zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0M4 4l16 16',
} as const;

export type IconName = keyof typeof PATHS;

/** Every icon name, for tests and pickers. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];
