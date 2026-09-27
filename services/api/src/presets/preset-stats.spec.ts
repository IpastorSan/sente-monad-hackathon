/**
 * The cohort stats' rules (SEN-76): who is in the window, how the medians are
 * taken, and when they are withheld.
 */
import type { AgentEvent } from '../agents/events/agent-event-log';
import {
  activeInWindow,
  depositedCapital,
  floorRatio,
  medianRatio,
  medianScaled,
  presetStats,
  PRESET_STATS_WINDOW_MS,
  ratioOf,
  windowPnl,
  type CohortRecord,
} from './preset-stats';

const NOW = Date.UTC(2026, 8, 27);
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function agent(id: string, over: Partial<CohortRecord> = {}): CohortRecord {
  return {
    id,
    status: 'active',
    createdAt: new Date(NOW - 60 * DAY),
    updatedAt: new Date(NOW - 60 * DAY),
    preset: { id: 'guardian', version: 1, params: {}, customized: false },
    ...over,
  };
}

function verdict(agentId: string, pnl: string, at = NOW - DAY, asset = 'USDC'): AgentEvent {
  return {
    seq: ++seq,
    agentId,
    at,
    kind: 'verdict',
    detail: { realisedPnl: pnl, pnlAsset: asset },
  };
}

function deposit(agentId: string, amount: string, asset = 'USDC', at = NOW - 40 * DAY): AgentEvent {
  return { seq: ++seq, agentId, at, kind: 'deposit', detail: { asset, amount } };
}

function d(value: string) {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

describe('activeInWindow', () => {
  it('counts an active agent, and one revoked inside the window', () => {
    expect(activeInWindow(agent('a'), NOW)).toBe(true);
    expect(
      activeInWindow(agent('b', { status: 'revoked', revokedAt: new Date(NOW - 29 * DAY) }), NOW),
    ).toBe(true);
  });

  it('includes the window boundary and drops anything revoked before it', () => {
    const edge = new Date(NOW - PRESET_STATS_WINDOW_MS);
    expect(activeInWindow(agent('a', { status: 'revoked', revokedAt: edge }), NOW)).toBe(true);
    const before = new Date(NOW - PRESET_STATS_WINDOW_MS - 1);
    expect(activeInWindow(agent('b', { status: 'revoked', revokedAt: before }), NOW)).toBe(false);
  });

  it('reads a revoked record without revokedAt as stopped at its last update', () => {
    const old = agent('a', { status: 'revoked', updatedAt: new Date(NOW - 31 * DAY) });
    expect(activeInWindow(old, NOW)).toBe(false);
  });

  it('does not count an agent hired after now', () => {
    expect(activeInWindow(agent('a', { createdAt: new Date(NOW + 1) }), NOW)).toBe(false);
  });
});

describe('windowPnl and depositedCapital', () => {
  it('sums only the window’s verdicts, USDC and AUSD together, other assets out', () => {
    const events = [
      verdict('a', '1.5'),
      verdict('a', '-0.25', NOW - 2 * DAY, 'AUSD'),
      verdict('a', '100', NOW - 31 * DAY),
      verdict('a', '7', NOW - DAY, 'MON'),
      deposit('a', '50'),
    ];
    expect(windowPnl(events, NOW)).toEqual(d('1.25'));
  });

  it('counts stable deposits from any time up to now, and skips unreadable ones', () => {
    const events = [
      deposit('a', '100'),
      deposit('a', '20.5', 'AUSD', NOW - DAY),
      deposit('a', '3', 'MON'),
      deposit('a', '1e-7'),
      deposit('a', '9', 'USDC', NOW + 1),
    ];
    expect(depositedCapital(events, NOW)).toEqual(d('120.5'));
  });
});

describe('medians', () => {
  it('takes the middle of an odd count and the exact mean of the middle two of an even one', () => {
    expect(medianScaled(['3', '-1', '2'].map(d))).toEqual(d('2'));
    expect(medianScaled(['1', '2', '4', '-9'].map(d))).toEqual({ units: 15n, scale: 1 });
    expect(medianScaled(['0.01', '0.02'].map(d))).toEqual({ units: 15n, scale: 3 });
    expect(medianScaled([])).toBeUndefined();
  });

  it('keeps returns exact until the end, then floors them', () => {
    // 1/3, 2/3: median 1/2 exactly, not 0.4999995
    const m = medianRatio([ratioOf(d('1'), d('3')), ratioOf(d('2'), d('3'))])!;
    expect(floorRatio(m, 6)).toBe('0.5');
    // floors towards −∞: a loss never rounds smaller, a gain never rounds up
    expect(floorRatio(ratioOf(d('-1'), d('3')), 6)).toBe('-0.333334');
    expect(floorRatio(ratioOf(d('2'), d('3')), 6)).toBe('0.666666');
  });
});

describe('presetStats', () => {
  function cohort(size: number, pnl: (i: number) => string, withDeposit: (i: number) => boolean) {
    const agents: CohortRecord[] = [];
    const events = new Map<string, AgentEvent[]>();
    for (let i = 0; i < size; i += 1) {
      const id = `g${i}`;
      agents.push(agent(id));
      events.set(id, [verdict(id, pnl(i)), ...(withDeposit(i) ? [deposit(id, '100')] : [])]);
    }
    return { agents, events };
  }

  it('withholds both medians below minN', () => {
    const { agents, events } = cohort(
      4,
      () => '5',
      () => true,
    );
    const stats = presetStats({
      presetId: 'guardian',
      agents,
      events,
      truncation: new Map(),
      now: NOW,
    });
    expect(stats).toMatchObject({
      n: 4,
      returnN: 4,
      minN: 5,
      medianPnl30d: null,
      medianReturn30d: null,
    });
    expect(stats.notes.some((n) => n.startsWith('Too new to rate'))).toBe(true);
  });

  it('reports returnN apart from n, and withholds the return alone when it is short', () => {
    const { agents, events } = cohort(
      6,
      (i) => String(i),
      (i) => i < 3,
    );
    const stats = presetStats({
      presetId: 'guardian',
      agents,
      events,
      truncation: new Map(),
      now: NOW,
    });
    expect(stats).toMatchObject({ n: 6, returnN: 3, medianPnl30d: '2.5', medianReturn30d: null });
  });

  it('computes both medians at minN, with returns as fractions of capital', () => {
    const { agents, events } = cohort(
      5,
      (i) => String(i - 2),
      () => true,
    );
    const stats = presetStats({
      presetId: 'guardian',
      agents,
      events,
      truncation: new Map(),
      now: NOW,
    });
    expect(stats).toMatchObject({ n: 5, returnN: 5, medianPnl30d: '0', medianReturn30d: '0' });
  });

  it('counts revoked-in-window and customised agents, and an idle one as 0', () => {
    const agents = [
      agent('a'),
      agent('b', { status: 'revoked', revokedAt: new Date(NOW - 10 * DAY) }),
      agent('c', { preset: { id: 'guardian', version: 1, params: {}, customized: true } }),
      agent('d'),
      agent('e'),
      agent('old', { status: 'revoked', revokedAt: new Date(NOW - 40 * DAY) }),
      agent('other', { preset: { id: 'dca-stacker', version: 1, params: {}, customized: false } }),
      agent('free', { preset: undefined }),
    ];
    const events = new Map<string, AgentEvent[]>([
      ['a', [verdict('a', '10')]],
      ['b', [verdict('b', '-30')]],
      ['c', [verdict('c', '4')]],
      ['d', [verdict('d', '6')]],
      // e settled nothing: counts as 0
    ]);
    const stats = presetStats({
      presetId: 'guardian',
      agents,
      events,
      truncation: new Map(),
      now: NOW,
    });
    expect(stats).toMatchObject({
      presetId: 'guardian',
      window: '30d',
      running: 4,
      n: 5,
      customized: 1,
      medianPnl30d: '4',
      returnN: 0,
      medianReturn30d: null,
      asOf: NOW,
    });
  });
});

describe('presetStats over a truncated log (SEN-129)', () => {
  /** `size` agents, each +10 on 100 deposited: a median return of 0.1. */
  function cohort(size = 6) {
    const agents: CohortRecord[] = [];
    const events = new Map<string, AgentEvent[]>();
    for (let i = 0; i < size; i += 1) {
      const id = `g${i}`;
      agents.push(agent(id));
      events.set(id, [deposit(id, '100'), verdict(id, '10')]);
    }
    return { agents, events };
  }

  it('leaves an agent whose deposits may be gone out of the return, not in at a smaller capital', () => {
    const { agents, events } = cohort();
    // g0..g2's first deposit was evicted (long before the window); what is left
    // is a second deposit of 10, so their "return" would read 10 / 10 = 1.0.
    // Counted, they would drag the median from 0.1 to 0.55.
    const truncation = new Map<string, { evicted: number; newestEvictedAt: number }>();
    for (const id of ['g0', 'g1', 'g2']) {
      events.set(id, [deposit(id, '10'), verdict(id, '10')]);
      truncation.set(id, { evicted: 1, newestEvictedAt: NOW - 50 * DAY });
    }

    const stats = presetStats({ presetId: 'guardian', agents, events, truncation, now: NOW });

    // Their window is whole (nothing dropped after NOW - 50d), so P&L still counts them.
    expect(stats).toMatchObject({ n: 6, medianPnl30d: '10', returnN: 3, medianReturn30d: null });
    expect(stats.notes.join(' ')).toContain('oldest events of 3 of 6 agents');
  });

  it('leaves an agent out of the P&L median when the eviction reached into the window', () => {
    const { agents, events } = cohort(10);
    // Half the cohort lost events from inside the window: what is left of it
    // (a -500 whose winning trades were evicted, say) would pull the median to -245.
    const truncation = new Map<string, { evicted: number; newestEvictedAt: number }>();
    for (const id of ['g0', 'g1', 'g2', 'g3', 'g4']) {
      events.set(id, [verdict(id, '-500')]);
      truncation.set(id, { evicted: 7, newestEvictedAt: NOW - 2 * DAY });
    }

    const stats = presetStats({ presetId: 'guardian', agents, events, truncation, now: NOW });

    expect(stats).toMatchObject({ n: 10, medianPnl30d: '10', returnN: 5, medianReturn30d: '0.1' });
    expect(stats.notes.join(' ')).toContain('5 are left out of the median P&L');
  });

  it('withholds the P&L median when too few agents have a whole window', () => {
    const { agents, events } = cohort();
    const truncation = new Map([
      ['g0', { evicted: 1, newestEvictedAt: NOW }],
      ['g1', { evicted: 1, newestEvictedAt: NOW }],
    ]);
    const stats = presetStats({ presetId: 'guardian', agents, events, truncation, now: NOW });
    expect(stats).toMatchObject({ n: 6, medianPnl30d: null, returnN: 4, medianReturn30d: null });
  });
});
