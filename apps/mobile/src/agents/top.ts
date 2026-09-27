/**
 * The Top segment's pinned row (SEN-114; agents.html → "Top agents"): where
 * the user's best agent stands. Pure, pinned by `top.test.ts`.
 *
 * Only a RANKED agent can be "your best": an agent under the trade minimum has
 * no place in the order, and pinning it with a rank would invent one.
 */
export type RankedRow = { readonly agentId: string; readonly rank: number | null };

export type YourBest<Row extends RankedRow> = { row: Row; label: string };

export function yourBest<Row extends RankedRow>(
  ranked: readonly Row[],
  owned: ReadonlySet<string>,
): YourBest<Row> | null {
  let best: (Row & { rank: number }) | null = null;
  for (const row of ranked) {
    if (row.rank === null || !owned.has(row.agentId)) continue;
    if (best === null || row.rank < best.rank) best = row as Row & { rank: number };
  }
  if (best === null) return null;
  const total = ranked.filter((row) => row.rank !== null).length;
  return { row: best, label: `Your best · ${ordinal(best.rank)} of ${total} ranked` };
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `22nd`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
