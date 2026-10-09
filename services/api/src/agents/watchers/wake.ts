/**
 * Why Sente started a scheduled run of an agent that has watchers (SEN-182):
 * one or more watchers fired, or the heartbeat came due. Written by Sente,
 * not the user, so the runner shows it outside the user's fences — but the
 * labels were written by the agent (or its owner), so they are defused there.
 */
import type { Firing } from './watcher-eval';

export interface RunWake {
  readonly reason: 'watchers' | 'heartbeat';
  /** Unix epoch ms: when the check that woke it ran. */
  readonly at: number;
  readonly fired: readonly Firing[];
  /** Heartbeat only: how long since the last run, in seconds. */
  readonly idleSeconds?: number;
}

const MAX_LABEL = 120;
const MAX_OBSERVED = 300;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One line per firing: `“MACD 15m cross” — BTC-PERP 15m macd(12,26,9).line 1.23 crossed above …`. */
export function firingLines(wake: RunWake): string[] {
  return wake.fired.map(
    (f) => `“${clip(f.label, MAX_LABEL)}” (${f.id}) — ${clip(f.observed, MAX_OBSERVED)}`,
  );
}

/** The transcript's line: what the terminal shows at the top of the run. */
export function wakeNote(wake: RunWake): string {
  if (wake.reason === 'heartbeat') {
    const hours = wake.idleSeconds === undefined ? '' : ` after ${formatIdle(wake.idleSeconds)}`;
    return `Woken by the heartbeat${hours} with no watcher firing: time to re-plan.`;
  }
  return `Woken by: ${firingLines(wake).join(' · ')}`;
}

function formatIdle(seconds: number): string {
  const hours = seconds / 3_600;
  return hours >= 1 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(seconds / 60)} min`;
}
