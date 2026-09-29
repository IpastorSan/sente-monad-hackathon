import type { AgentEvent } from '../events/agent-event-log';
import { restingKuruOrders } from './resting-orders';

let seq = 0;
function event(
  kind: AgentEvent['kind'],
  tool: string,
  detail: Record<string, unknown>,
): AgentEvent {
  seq += 1;
  return { seq, agentId: 'agent-1', at: 1_000 + seq, kind, tool, detail };
}

function placed(id: string, over: Record<string, unknown> = {}, venue = 'kuru'): AgentEvent {
  return event('order', 'place_limit', {
    status: 'ok',
    args: { venue, market: 'MON-USDC' },
    result: {
      id,
      symbol: 'MON-USDC',
      side: 'buy',
      status: 'open',
      size: '10',
      filledSize: '0',
      blockNumber: 500,
      ...over,
    },
  });
}

function fill(orderId: string, size: string, over: Record<string, unknown> = {}): AgentEvent {
  return event('fill', 'place_limit', {
    orderId,
    venue: 'kuru',
    symbol: 'MON-USDC',
    side: 'buy',
    filledSize: size,
    averageFillPrice: '0.03',
    ...over,
  });
}

describe('restingKuruOrders (SEN-149)', () => {
  it('watches an order that rested, from its placement block', () => {
    const { open } = restingKuruOrders([placed('0:1')]);
    expect(open).toEqual([
      {
        agentId: 'agent-1',
        symbol: 'MON-USDC',
        orderId: '0:1',
        tool: 'place_limit',
        fromBlock: 500n,
        cancelledAt: undefined,
      },
    ]);
  });

  it('ignores what cannot rest: IOC results, failures, Perpl, and orders that filled whole', () => {
    const { open } = restingKuruOrders([
      placed('0xhash', { status: 'cancelled' }),
      event('order', 'place_limit', { status: 'failed', args: { venue: 'kuru' } }),
      placed('0:2', {}, 'perpl'),
      placed('0:3', { status: 'filled', filledSize: '10' }),
    ]);
    expect(open).toEqual([]);
  });

  it('counts the placement fill once and later fills exactly, and resumes from the last later fill', () => {
    const events = [
      placed('0:1', { status: 'partially_filled', filledSize: '2.5' }),
      fill('0:1', '2.5', { blockNumber: 500 }),
      fill('0:1', '7', {
        source: 'resting',
        tradeKey: 'kuru:0xa:1:0',
        blockNumber: 640,
        remainingSize: '0.5',
      }),
    ];
    const state = restingKuruOrders(events);
    expect(state.open.map((o) => [o.orderId, o.fromBlock])).toEqual([['0:1', 640n]]);
    expect([...state.recorded]).toEqual(['kuru:0xa:1:0']);

    // The last half fills: 2.5 + 7 + 0.5 = 10, nothing left.
    expect(restingKuruOrders([...events, fill('0:1', '0.5', { source: 'resting' })]).open).toEqual(
      [],
    );
  });

  it('stops at a fill reporting nothing left, even short of the size (dust removed by the book)', () => {
    const { open } = restingKuruOrders([
      placed('0:1'),
      fill('0:1', '9.99999', { source: 'resting', remainingSize: '0' }),
    ]);
    expect(open).toEqual([]);
  });

  it('marks a landed cancel, but keeps the order: a fill may predate it', () => {
    const cancel = event('order', 'cancel_order', {
      status: 'ok',
      args: { venue: 'kuru', market: 'MON-USDC', orderId: '0:1' },
      result: { id: '0:1', status: 'cancelled' },
    });
    const { open } = restingKuruOrders([placed('0:1'), cancel]);
    expect(open).toHaveLength(1);
    expect(open[0]!.cancelledAt).toBe(cancel.at);
  });

  it('keys orders by market as well as id: two books can reuse one "<slot>:<id>"', () => {
    const weth = placed('0:1', { symbol: 'WETH-USDC' });
    const { open } = restingKuruOrders([placed('0:1'), weth, fill('0:1', '10')]);
    expect(open.map((o) => o.symbol)).toEqual(['WETH-USDC']);
  });
});
