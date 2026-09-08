import { IpRateLimiter } from './ip-rate-limiter';

const t = (ms: number): Date => new Date(1_700_000_000_000 + ms);

describe('IpRateLimiter', () => {
  it('allows up to max attempts inside the window and refuses the next', () => {
    const limiter = new IpRateLimiter(3, 60_000);

    expect(limiter.hit('1.2.3.4', t(0))).toBe(true);
    expect(limiter.hit('1.2.3.4', t(1))).toBe(true);
    expect(limiter.hit('1.2.3.4', t(2))).toBe(true);
    expect(limiter.hit('1.2.3.4', t(3))).toBe(false);
    expect(limiter.remaining('1.2.3.4', t(3))).toBe(0);
  });

  it('keys independently per IP', () => {
    const limiter = new IpRateLimiter(1, 60_000);

    expect(limiter.hit('1.1.1.1', t(0))).toBe(true);
    expect(limiter.hit('1.1.1.1', t(1))).toBe(false);
    expect(limiter.hit('2.2.2.2', t(1))).toBe(true);
  });

  it('lets the window slide, and a blocked caller cannot push it forward', () => {
    const limiter = new IpRateLimiter(2, 60_000);

    expect(limiter.hit('9.9.9.9', t(0))).toBe(true);
    expect(limiter.hit('9.9.9.9', t(0))).toBe(true);
    // Hammering while blocked must not record hits that keep it blocked.
    expect(limiter.hit('9.9.9.9', t(30_000))).toBe(false);
    expect(limiter.hit('9.9.9.9', t(40_000))).toBe(false);

    expect(limiter.hit('9.9.9.9', t(60_001))).toBe(true);
  });

  it('sweeps expired keys once it is tracking more than the threshold', () => {
    const limiter = new IpRateLimiter(1, 1_000, 4);

    for (let i = 0; i < 5; i += 1) {
      limiter.hit(`10.0.0.${i}`, t(0));
    }
    // Every earlier key is now expired; the sweep on this hit drops them.
    expect(limiter.hit('10.0.1.1', t(5_000))).toBe(true);
    expect(limiter.remaining('10.0.0.0', t(5_000))).toBe(1);
  });
});
