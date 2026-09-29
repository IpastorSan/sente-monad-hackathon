import type { AgentEvent } from './agent-event-log';
import { marketFills, type AgentLog } from './market-fills';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function fill(agentId: string, at: number, detail: Record<string, unknown>): AgentEvent {
  seq += 1;
  return {
    seq,
    agentId,
    at,
    kind: 'fill',
    tool: 'place_order',
    detail: {
      orderId: `o-${seq}`,
      symbol: 'MON-USDC',
      side: 'buy',
      filledSize: '180',
      averageFillPrice: '0.9744',
      txHash: `0x${seq}`,
      venue: 'kuru',
      ...detail,
    },
  };
}

function log(id: string, name: string, events: AgentEvent[]): AgentLog {
  return { agent: { id, name }, events };
}

describe('marketFills (SEN-157)', () => {
  it("merges every agent's fills for one market, newest first, and only fills", () => {
    const hunter = log('a', 'Range Hunter', [
      fill('a', 100, {}),
      { ...fill('a', 150, {}), kind: 'order' },
      fill('a', 300, {}),
    ]);
    const other = log('b', 'Momentum', [fill('b', 200, { side: 'sell' })]);

    const fills = marketFills([hunter, other], { venue: 'kuru', symbol: 'MON-USDC', limit: 50 });

    expect(fills.map((f) => [f.agentName, f.at, f.side])).toEqual([
      ['Range Hunter', 300, 'buy'],
      ['Momentum', 200, 'sell'],
      ['Range Hunter', 100, 'buy'],
    ]);
    expect(fills[0]).toEqual({
      seq: 3,
      agentId: 'a',
      agentName: 'Range Hunter',
      venue: 'kuru',
      symbol: 'MON-USDC',
      side: 'buy',
      price: '0.9744',
      size: '180',
      orderId: 'o-3',
      txHash: '0x3',
      at: 300,
    });
  });

  it('scopes by venue, symbol and since, and caps at limit', () => {
    const logs = [
      log('a', 'A', [
        fill('a', 100, {}),
        fill('a', 200, { symbol: 'ETH-USDC' }),
        fill('a', 300, { venue: 'perpl', symbol: 'MON-USDC' }),
        fill('a', 400, {}),
        fill('a', 500, {}),
      ]),
    ];
    const at = (q: Parameters<typeof marketFills>[1]) => marketFills(logs, q).map((f) => f.at);

    expect(at({ venue: 'kuru', symbol: 'MON-USDC', limit: 50 })).toEqual([500, 400, 100]);
    expect(at({ venue: 'kuru', symbol: 'MON-USDC', since: 400, limit: 50 })).toEqual([500, 400]);
    expect(at({ venue: 'kuru', symbol: 'MON-USDC', limit: 2 })).toEqual([500, 400]);
    expect(at({ venue: 'perpl', limit: 50 })).toEqual([300]);
  });

  it('infers the venue of a fill recorded without one, the way verdicts do', () => {
    const logs = [
      log('a', 'A', [
        fill('a', 100, { venue: undefined }),
        fill('a', 200, { venue: undefined, leverage: 3 }),
      ]),
    ];
    expect(marketFills(logs, { venue: 'kuru', limit: 50 }).map((f) => f.at)).toEqual([100]);
    expect(marketFills(logs, { venue: 'perpl', limit: 50 }).map((f) => f.at)).toEqual([200]);
  });

  it('skips a fill that names no market or size, and nulls what is missing', () => {
    const logs = [
      log('a', 'A', [
        fill('a', 100, { symbol: undefined }),
        fill('a', 200, { filledSize: undefined }),
        fill('a', 300, { side: 'x', averageFillPrice: undefined, txHash: undefined }),
      ]),
    ];
    expect(marketFills(logs, { limit: 50 })).toEqual([
      expect.objectContaining({ at: 300, side: null, price: null, txHash: null }),
    ]);
  });
});
