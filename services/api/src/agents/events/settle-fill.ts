import { Logger } from '@nestjs/common';

import type { AgentEventLog } from './agent-event-log';
import { settle } from './verdict';

const logger = new Logger('AgentVerdicts');

/**
 * A verdict event for the thesis a fill just settled (SEN-22, SEN-47).
 *
 * Shared by every writer of a `fill`: the gate for fills at placement, and the
 * resting-fill watcher for a resting Kuru order that fills later (SEN-149) —
 * which is how a spot thesis closed by a limit sell gets its verdict at all.
 *
 * `settle` is a pure read of the agent's events, so it only sees the fill (and,
 * for a Perpl close, the `close`) once it is on the log. Only a thesis whose
 * position came back to zero is settled — one that is still open, a partial
 * fill, and a fill with no thesis behind it, record nothing.
 *
 * Every filling tool reaches here, not just `close_position` (SEN-47). Kuru has
 * no close: a spot thesis ends when its own fills net out, and settling only on
 * `close_position` meant two of the three verdict consumers — the Ledger and the
 * ERC-8004 reputation hook, which both read the `verdict` EVENT — missed every
 * Kuru outcome, while the leaderboard, which calls `settle` itself, counted it.
 *
 * The log is read for the WHOLE AGENT, not for one run (SEN-33). A scheduled
 * agent records its thesis in one tick and closes the position in a later one,
 * and a run-scoped read never found that thesis. Reading across runs means the
 * same thesis can be reached by a second fill, so a thesis that already has a
 * verdict on the log is not settled twice — which is the whole guard against
 * duplicates now that every fill asks. Callers hold the agent's write lock, so
 * two fills cannot both pass that check.
 *
 * Never throws: the fill happened, and a log that will not take the verdict
 * must not turn that into a failure.
 */
export async function recordVerdictFor(
  events: AgentEventLog,
  on: { readonly agentId: string; readonly runId?: string; readonly tool?: string },
  fill: Readonly<Record<string, unknown>>,
): Promise<void> {
  const market = fill['symbol'];
  if (typeof market !== 'string') return;
  try {
    const history = await events.list(on.agentId);
    const verdict = settle(history).findLast((v) => v.market === market);
    if (verdict === undefined || verdict.held === 'open') return;
    const settled = history.some(
      (e) => e.kind === 'verdict' && e.detail['thesisSeq'] === verdict.thesisSeq,
    );
    if (settled) return;
    await events.append({
      agentId: on.agentId,
      ...(on.runId !== undefined ? { runId: on.runId } : {}),
      kind: 'verdict',
      ...(on.tool !== undefined ? { tool: on.tool } : {}),
      detail: {
        ...verdict,
        // The block the settling fill confirmed in, so the Ledger draws the
        // same consensus ramp under the verdict as under the fill that caused
        // it: since SEN-35 any event that NAMES a block gets one.
        ...(fill['blockNumber'] !== undefined ? { blockNumber: fill['blockNumber'] } : {}),
      },
    });
  } catch (error) {
    logger.error(`could not settle ${market} for agent ${on.agentId}: ${String(error)}`);
  }
}
