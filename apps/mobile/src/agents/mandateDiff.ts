/**
 * What an amendment CHANGES, for the approval sheet (SEN-59).
 *
 * The passkey sheet (SEN-44) used to read the whole new mandate back, which
 * buries the one line that moved under ten that didn't. This compares the two
 * mandates limit by limit and keeps only what differs, so the sheet can show
 * the old value struck through beside the new one.
 *
 * Labels and values come from `describeMandate`, so a limit reads the same on
 * the sheet, the review step and the agent page. The market lists are the one
 * exception: they are compared as sets, so adding a market reads as "+ WETH-USDC"
 * rather than as a whole new list.
 *
 * This is display only. What the passkey actually signs is decided in
 * `approval.ts`, from the prepared payload against the mandate this phone built.
 *
 * Plain node, no React Native, so `mandateDiff.test.ts` runs without a device.
 */
import type { AgentMandate } from './api.ts';
import { describeMandate, marketFor, type Enforcer, type MandateLimit } from './mandate.ts';

type ChangeBase = { id: string; label: string; enforcer: Enforcer };

export type MandateChange =
  /** A single value. `null` on one side: the limit is new, or gone. */
  | (ChangeBase & { kind: 'value'; before: string | null; after: string | null })
  /** A set of names — venues, markets. */
  | (ChangeBase & { kind: 'list'; kept: string[]; added: string[]; removed: string[] });

const VENUE_NAMES = { kuru: 'Kuru', perpl: 'Perpl' } as const;

/**
 * The limits compared as sets, and each one's items; `describeMandate`'s
 * values for the markets are these lists, joined. The venues are here too:
 * `describeMandate` states them in prose rather than as a row.
 */
const LISTS: Record<string, (mandate: AgentMandate) => string[]> = {
  venues: (mandate) => mandate.venues.map((venue) => VENUE_NAMES[venue]),
  'kuru.markets': (mandate) =>
    mandate.venues.includes('kuru')
      ? mandate.kuru.markets.map((address) => marketFor(address)?.symbol ?? address)
      : [],
  'perpl.markets': (mandate) => (mandate.venues.includes('perpl') ? mandate.perpl.markets : []),
};

const VENUES: MandateLimit = { id: 'venues', label: 'Venues', value: '', enforcer: 'enclave' };

/** Only the limits that differ, in the order the new mandate reads; dropped ones last. */
export function diffMandates(before: AgentMandate, after: AgentMandate): MandateChange[] {
  const old = new Map(describeMandate(before).map((limit) => [limit.id, limit]));
  const next = new Map(describeMandate(after).map((limit) => [limit.id, limit]));
  const changes: MandateChange[] = [];

  // A Set keeps first insertion: the new mandate's order, then what it dropped.
  for (const id of new Set(['venues', ...next.keys(), ...old.keys()])) {
    const limit = id === 'venues' ? VENUES : (next.get(id) ?? old.get(id));
    if (!limit) continue;
    const base = { id, label: limit.label, enforcer: limit.enforcer };
    const list = LISTS[id];
    if (list) {
      const from = list(before);
      const to = list(after);
      const added = to.filter((item) => !from.includes(item));
      const removed = from.filter((item) => !to.includes(item));
      if (added.length > 0 || removed.length > 0) {
        const kept = to.filter((item) => from.includes(item));
        changes.push({ ...base, kind: 'list', kept, added, removed });
      }
      continue;
    }
    const was = old.get(id)?.value ?? null;
    const now = next.get(id)?.value ?? null;
    if (was !== now) changes.push({ ...base, kind: 'value', before: was, after: now });
  }
  return changes;
}
