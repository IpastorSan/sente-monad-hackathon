/** DI token for the drip endpoint's per-IP limiter. */
export const IP_RATE_LIMITER = Symbol('IP_RATE_LIMITER');

/**
 * Coarse fixed-cost sliding-window limiter, keyed by client IP.
 *
 * This is a speed bump, not a defence: an attacker with a proxy pool walks past
 * it. It exists so a single misbehaving client cannot burn the daily cap in one
 * loop. The per-user and per-address ledger guards are the real limits.
 *
 * Process-local like the ledger, and for the same reason — see `drip-ledger.ts`.
 */
export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** Above this many tracked IPs, a hit also sweeps expired keys. */
    private readonly sweepThreshold = 10_000,
  ) {}

  /** Records an attempt. Returns false when the caller is over the limit. */
  hit(key: string, now: Date = new Date()): boolean {
    const at = now.getTime();
    const cutoff = at - this.windowMs;

    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (recent.length >= this.max) {
      // Keep the pruned list so the window still slides while blocked, but do
      // not extend it — a blocked caller cannot push its own window forward.
      this.hits.set(key, recent);
      return false;
    }

    recent.push(at);
    this.hits.set(key, recent);

    if (this.hits.size > this.sweepThreshold) {
      this.sweep(cutoff);
    }
    return true;
  }

  /** Attempts still available for this key. Exposed for tests and diagnostics. */
  remaining(key: string, now: Date = new Date()): number {
    const cutoff = now.getTime() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    return Math.max(0, this.max - recent.length);
  }

  private sweep(cutoff: number): void {
    for (const [key, stamps] of this.hits) {
      const recent = stamps.filter((stamp) => stamp > cutoff);
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
    }
  }
}
