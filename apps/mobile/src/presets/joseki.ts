/**
 * Joseki: each preset's shape drawn as stones on a slice of the board
 * (SEN-114; agents.html → "Agents tab", the `J` table in its script).
 *
 * No robots: a band for ranges, a ladder for trends, mirrored pairs for
 * funding. Rows run top (high price) to bottom (low price). Purple stones are
 * the agent's moves, white ones the market's, and hollow rings are levels the
 * agent WATCHES — never a resting order, since presets place none (their
 * stops and targets are checked every run, see `@sente/presets`).
 *
 * Pure: `joseki.test.ts` pins the geometry; `ui/joseki.tsx` only draws it.
 */

/** `agent` = purple stone, `white` = the market's stone, `watched` = a hollow ring. */
export type JosekiStoneKind = 'agent' | 'white' | 'watched';

export type JosekiPattern = {
  /** Rows with a dashed line across: the range's edges, the mean. */
  readonly bands: readonly number[];
  /** `[column, row, kind]` on a 7 × 5 board. */
  readonly stones: readonly (readonly [number, number, JosekiStoneKind])[];
};

export const JOSEKI_COLS = 7;
export const JOSEKI_ROWS = 5;

const P = 'agent';
const W = 'white';
const R = 'watched';

/** Keyed by preset id. Transcribed from the study so the app and it cannot disagree. */
const PATTERNS: Record<string, JosekiPattern> = {
  'range-trader': {
    bands: [0, 4],
    stones: [
      [1, 4, P],
      [4, 4, P],
      [2, 0, W],
      [5, 0, W],
    ],
  },
  'trend-rider': {
    bands: [],
    stones: [
      [0, 4, P],
      [1, 4, P],
      [1, 3, P],
      [2, 3, P],
      [2, 2, P],
      [3, 2, P],
      [3, 1, P],
      [4, 1, P],
      [4, 0, P],
      [3, 3, R],
    ],
  },
  'funding-harvester': {
    bands: [2],
    stones: [
      [1, 1, P],
      [1, 3, W],
      [3, 1, P],
      [3, 3, W],
      [5, 1, P],
      [5, 3, W],
    ],
  },
  'dca-stacker': {
    bands: [],
    stones: [
      [0, 3, P],
      [2, 3, P],
      [4, 3, P],
      [6, 3, P],
      [6, 1, R],
    ],
  },
  'mean-reverter': {
    bands: [2],
    stones: [
      [0, 0, W],
      [1, 4, P],
      [3, 0, W],
      [4, 4, P],
      [6, 2, R],
    ],
  },
  guardian: {
    bands: [0, 4],
    stones: [
      [3, 2, W],
      [3, 0, R],
      [3, 4, R],
      [2, 2, P],
      [4, 2, P],
    ],
  },
};

/** A preset the app has no drawing for (added server-side later) gets an empty board. */
export function josekiFor(presetId: string): JosekiPattern {
  return PATTERNS[presetId] ?? { bands: [], stones: [] };
}

export type Segment = { x1: number; y1: number; x2: number; y2: number };
export type PlacedStone = { cx: number; cy: number; r: number; kind: JosekiStoneKind };
export type JosekiLayout = {
  grid: Segment[];
  bands: Segment[];
  stones: PlacedStone[];
  /** Stroke widths, in box pixels, so small and large read the same. */
  gridStroke: number;
  bandStroke: number;
  ringStroke: number;
  dash: [number, number];
};

/**
 * Lays a pattern out in a `width × height` box. The study draws into a fixed
 * viewBox (100 × 84 small, 300 × 132 large) with `preserveAspectRatio="meet"`;
 * this does the same fit — uniform scale, centred — in box pixels.
 */
export function josekiLayout(
  pattern: JosekiPattern,
  box: { width: number; height: number },
  large = false,
): JosekiLayout {
  const vw = large ? 300 : 100;
  const vh = large ? 132 : 84;
  const pad = large ? 14 : 9;
  const scale = Math.min(box.width / vw, box.height / vh);
  const ox = (box.width - vw * scale) / 2;
  const oy = (box.height - vh * scale) / 2;
  const sx = (vw - 2 * pad) / (JOSEKI_COLS - 1);
  const sy = (vh - 2 * pad) / (JOSEKI_ROWS - 1);
  const X = (c: number) => ox + (pad + c * sx) * scale;
  const Y = (r: number) => oy + (pad + r * sy) * scale;
  const left = ox + pad * scale;
  const right = ox + (vw - pad) * scale;
  const r = Math.min(sx, sy) * (large ? 0.4 : 0.47) * scale;

  const grid: Segment[] = [];
  for (let c = 0; c < JOSEKI_COLS; c++) {
    grid.push({ x1: X(c), y1: Y(0), x2: X(c), y2: Y(JOSEKI_ROWS - 1) });
  }
  for (let k = 0; k < JOSEKI_ROWS; k++) grid.push({ x1: left, y1: Y(k), x2: right, y2: Y(k) });

  return {
    grid,
    bands: pattern.bands.map((row) => ({
      x1: left - 4 * scale,
      y1: Y(row),
      x2: right + 4 * scale,
      y2: Y(row),
    })),
    stones: pattern.stones.map(([c, row, kind]) => ({
      cx: X(c),
      cy: Y(row),
      r: kind === 'watched' ? r * 0.82 : r,
      kind,
    })),
    gridStroke: (large ? 1 : 1.3) * scale,
    bandStroke: (large ? 1.5 : 2) * scale,
    ringStroke: (large ? 2 : 2.4) * scale,
    dash: large ? [4 * scale, 4 * scale] : [5 * scale, 4 * scale],
  };
}
