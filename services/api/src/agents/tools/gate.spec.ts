import { EnclaveRefusedError } from '../agents.errors';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { AgentTools, type ToolContext } from './context';
import { GATED_TOOLS, toResultText, type ToolOutcome } from './gate';
import { ENCLAVE_REFUSAL_MESSAGE } from './refusals';
import { BTC_PERP, EXPIRES_AT, MON_USDC, NOW, testAgent, WETH_USDC } from './testing/agent-fixture';
import { fakeVenues } from './testing/fake-venues';

const tool = (name: string) => {
  const found = GATED_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

async function harness(
  options: { precheck?: boolean; perpl?: boolean; agent?: Partial<AgentRecord> } = {},
) {
  const store = new InMemoryAgentStore();
  const agent = testAgent(options.agent);
  await store.insert(agent);
  const events = new InMemoryAgentEventLog();
  const fakes = fakeVenues(options.perpl === undefined ? {} : { perpl: options.perpl });
  let now = NOW;
  const tools = new AgentTools({
    store,
    events,
    precheck: options.precheck ?? true,
    venuesFor: () => Promise.resolve(fakes.venues),
    now: () => now,
  });
  const ctx = tools.context(agent, { runId: 'run-1' });
  const call = (name: string, args: unknown, context: ToolContext = ctx) =>
    tool(name).invoke(context, args);
  const thesis = (market = MON_USDC, context: ToolContext = ctx) =>
    call(
      'record_thesis',
      { market, direction: 'long', thesis: 'Breaking out.', invalidation: 'Back under 3.' },
      context,
    );
  const refusals = () => events.list(agent.id, { kind: 'refusal' });
  return {
    ...fakes,
    store,
    agent,
    events,
    tools,
    ctx,
    call,
    thesis,
    refusals,
    setNow: (value: number) => {
      now = value;
    },
  };
}

const limit = (over: Record<string, unknown> = {}) => ({
  venue: 'kuru',
  market: MON_USDC,
  side: 'buy',
  size: '10',
  price: '3.5',
  ...over,
});

function refused(outcome: ToolOutcome) {
  if (outcome.ok) throw new Error(`expected a refusal, got ${toResultText(outcome.result)}`);
  return outcome;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('gate', () => {
  it('refuses zod-invalid input before the handler runs', async () => {
    const h = await harness();
    await h.thesis();

    for (const args of [
      limit({ size: 10 }), // a number, not a decimal string
      limit({ price: undefined }),
      limit({ size: '-1' }),
      limit({ size: '0' }),
      limit({ venue: 'binance' }),
      limit({ extra: 'field' }), // strict: unknown keys are refused, not dropped
    ]) {
      const outcome = refused(await h.call('place_limit', args));
      expect(outcome.refusal).toEqual({ layer: 'sente', code: 'invalid_input' });
      expect(outcome.message).toMatch(/^Refused by Sente mandate: invalid_input\. /);
    }
    const bad = refused(await h.call('get_depth', { venue: 'kuru', market: MON_USDC, limit: 0 }));
    expect(bad.refusal?.code).toBe('invalid_input');
    expect(h.kuru.calls).toEqual([]);
  });

  it('requires a slippage bound on market orders', async () => {
    const h = await harness();
    await h.thesis();
    const outcome = refused(
      await h.call('place_market', { venue: 'kuru', market: MON_USDC, side: 'buy', size: '1' }),
    );
    expect(outcome.refusal?.code).toBe('invalid_input');
    expect(outcome.message).toContain('slippageLimitPrice');
    expect(h.kuru.writes()).toEqual([]);
  });

  it('refuses a write without a thesis for the same market in this run', async () => {
    const h = await harness();
    await h.thesis(WETH_USDC); // another market's thesis does not count

    const order = refused(await h.call('place_limit', limit()));
    expect(order.refusal).toEqual({ layer: 'sente', code: 'thesis_required' });
    expect(order.message).toMatch(
      /^Refused by Sente mandate: thesis_required\. Record your thesis first/,
    );
    const funding = refused(
      await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '5' }),
    );
    expect(funding.refusal?.code).toBe('thesis_required');

    // A thesis from another run (another context) does not carry over either.
    const other = h.tools.context(h.agent, { runId: 'run-2' });
    await h.thesis(MON_USDC, other);
    expect(refused(await h.call('place_limit', limit())).refusal?.code).toBe('thesis_required');
    expect((await h.call('place_limit', limit(), other)).ok).toBe(true);
    expect(h.kuru.writes()).toHaveLength(1);
  });

  it('lets cancel and close through without a thesis', async () => {
    const h = await harness();
    const cancel = await h.call('cancel_order', {
      venue: 'kuru',
      market: MON_USDC,
      orderId: '0:1',
    });
    const close = await h.call('close_position', { market: BTC_PERP });
    expect(cancel.ok && close.ok).toBe(true);
    expect(h.kuru.writes().map((c) => c.method)).toEqual(['cancel']);
    expect(h.perpl.writes().map((c) => c.method)).toEqual(['closePosition']);
  });

  it('lets withdraw through without a thesis, even after the mandate expires', async () => {
    const h = await harness();
    h.setNow(EXPIRES_AT + 86_400);
    const outcome = await h.call('withdraw', { asset: 'USDC', amount: '14' });
    expect(outcome).toEqual({
      ok: true,
      result: expect.objectContaining({ withdrawn: '14', asset: 'USDC' }),
    });
    expect(h.kuru.writes()).toEqual([
      { method: 'withdraw', args: { asset: 'USDC', amount: '14' } },
    ]);
    // Deposits, by contrast, stop at expiry.
    await h.thesis();
    const late = refused(await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '1' }));
    expect(late.refusal?.code).toBe('mandate_expired');
  });

  it('refuses withdraw off an allowed venue, and of an asset Kuru does not have', async () => {
    const perplOnly = await harness({
      agent: { mandate: { ...testAgent().mandate, venues: ['perpl'] } },
    });
    const off = refused(await perplOnly.call('withdraw', { asset: 'USDC', amount: '1' }));
    expect(off.refusal).toEqual({ layer: 'sente', code: 'venue_not_allowed' });

    const h = await harness();
    const odd = refused(await h.call('withdraw', { asset: 'DOGE', amount: '1' }));
    expect(odd.refusal?.code).toBe('invalid_input');
    const fine = refused(await h.call('withdraw', { asset: 'USDC', amount: '0.0000001' }));
    expect(fine.refusal?.code).toBe('invalid_input');
    expect(h.kuru.writes()).toEqual([]);
    expect(perplOnly.kuru.writes()).toEqual([]);
  });

  describe('a layer-1 refusal never calls the venue', () => {
    it.each([
      ['notional_over_cap', 'place_limit', limit({ size: '100' }), MON_USDC],
      ['market_not_allowed', 'place_limit', limit({ market: WETH_USDC }), WETH_USDC],
      ['market_not_allowed', 'place_limit', limit({ market: 'NOPE-USDC' }), 'NOPE-USDC'],
      [
        'leverage_over_cap',
        'place_limit',
        {
          venue: 'perpl',
          market: BTC_PERP,
          side: 'buy',
          size: '0.001',
          price: '60000',
          leverage: 10,
        },
        BTC_PERP,
      ],
      [
        'leverage_over_cap', // a Perpl order must name its leverage
        'place_market',
        {
          venue: 'perpl',
          market: BTC_PERP,
          side: 'buy',
          size: '0.001',
          slippageLimitPrice: '61000',
        },
        BTC_PERP,
      ],
      [
        'notional_over_cap', // a market buy is valued at its slippage ceiling
        'place_market',
        { venue: 'kuru', market: MON_USDC, side: 'buy', size: '10', slippageLimitPrice: '30' },
        MON_USDC,
      ],
      [
        'deposit_over_cap',
        'deposit',
        { market: MON_USDC, asset: 'USDC', amount: '1000.000001' },
        MON_USDC,
      ],
    ])('%s (%s)', async (code, name, args, market) => {
      const h = await harness();
      await h.thesis(market);

      const outcome = refused(await h.call(name, args));
      expect(outcome.refusal).toEqual({ layer: 'sente', code });
      expect(outcome.message).toMatch(new RegExp(`^Refused by Sente mandate: ${code}\\. `));
      expect(h.kuru.writes()).toEqual([]);
      expect(h.perpl.writes()).toEqual([]);
    });

    it('venue_not_allowed and mandate_expired', async () => {
      const kuruOnly = testAgent().mandate;
      const h = await harness({ agent: { mandate: { ...kuruOnly, venues: ['kuru'] } } });
      await h.thesis(BTC_PERP);
      const perpl = refused(
        await h.call('place_limit', {
          venue: 'perpl',
          market: BTC_PERP,
          side: 'buy',
          size: '0.001',
          price: '60000',
          leverage: 2,
        }),
      );
      expect(perpl.refusal?.code).toBe('venue_not_allowed');

      await h.thesis();
      h.setNow(EXPIRES_AT + 1);
      expect(refused(await h.call('place_limit', limit())).refusal?.code).toBe('mandate_expired');
      // Reducing risk still passes after expiry.
      expect(
        (await h.call('cancel_order', { venue: 'kuru', market: MON_USDC, orderId: '0:1' })).ok,
      ).toBe(true);
      expect(h.kuru.writes().map((c) => c.method)).toEqual(['cancel']);
      expect(h.perpl.writes()).toEqual([]);
    });
  });

  it('values a sell at the book price, not at a floor the agent chooses', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.quotePrice = '5';

    // 100 MON "at 0.01" is 1 USDC on paper, but 500 USDC at the book.
    const sell = refused(
      await h.call('place_limit', limit({ side: 'sell', size: '100', price: '0.01' })),
    );
    expect(sell.refusal?.code).toBe('notional_over_cap');
    expect(sell.message).toContain('500');
    expect(
      (await h.call('place_limit', limit({ side: 'sell', size: '40', price: '0.01' }))).ok,
    ).toBe(true);
  });

  it('checks the mandate as it is now, and stops an agent revoked mid-run', async () => {
    const h = await harness();
    await h.thesis();
    expect(refused(await h.call('place_limit', limit({ size: '100' }))).refusal?.code).toBe(
      'notional_over_cap',
    );

    await h.store.update(h.agent.id, { mandate: { ...h.agent.mandate, maxOrderNotional: '1000' } });
    expect((await h.call('place_limit', limit({ size: '100' }))).ok).toBe(true);

    await h.store.update(h.agent.id, { status: 'revoked' });
    const outcome = refused(await h.call('place_limit', limit()));
    expect(outcome.refusal).toEqual({ layer: 'sente', code: 'agent_inactive' });
    expect(h.kuru.writes()).toHaveLength(1);
  });

  describe('with the pre-check off', () => {
    it("surfaces the enclave's refusal as the enclave message", async () => {
      const h = await harness({ precheck: false });
      await h.thesis();
      h.kuru.onWrite = () =>
        Promise.reject(
          new EnclaveRefusedError({
            walletId: 'wallet-1',
            method: 'eth_signTransaction',
            detail: 'Policy violation: no rule allowed this',
          }),
        );

      // Over the notional cap: layer 1 would refuse it, so the enclave has to.
      const outcome = refused(await h.call('place_limit', limit({ size: '100' })));
      expect(outcome.message).toBe(ENCLAVE_REFUSAL_MESSAGE);
      expect(outcome.refusal).toEqual({ layer: 'enclave', code: 'policy_violation' });
      expect(outcome.message).not.toContain('wallet-1');
      expect(h.kuru.writes()).toHaveLength(1); // the venue was reached
      expect(h.kuru.calls.some((c) => c.method === 'quote')).toBe(false);

      const [event] = await h.refusals();
      expect(event).toMatchObject({
        layer: 'enclave',
        runId: 'run-1',
        tool: 'place_limit',
        detail: { code: 'policy_violation', method: 'eth_signTransaction', precheck: false },
      });
    });

    it('still requires the thesis', async () => {
      const h = await harness({ precheck: false });
      expect(refused(await h.call('place_limit', limit({ size: '100' }))).refusal?.code).toBe(
        'thesis_required',
      );
      expect(h.kuru.writes()).toEqual([]);
    });
  });

  it('finds an enclave refusal a venue wrapped as a cause', async () => {
    const h = await harness();
    await h.thesis();
    const enclave = new EnclaveRefusedError({
      walletId: 'wallet-1',
      method: 'eth_signTransaction',
    });
    h.kuru.onWrite = () => Promise.reject(new Error('submit failed', { cause: enclave }));

    const outcome = refused(await h.call('place_limit', limit()));
    expect(outcome.message).toBe(ENCLAVE_REFUSAL_MESSAGE);
  });

  it('serializes two parallel writes for one agent, and no other agent waits', async () => {
    const h = await harness();
    await h.thesis();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    h.kuru.onWrite = async (method) => {
      if (method !== 'placeLimit') return; // only this agent's two orders are counted
      active++;
      maxActive = Math.max(maxActive, active);
      if (h.kuru.writes().length === 1) await held;
      active--;
    };

    const first = h.call('place_limit', limit({ clientOrderId: 'a' }));
    const second = h.call('place_limit', limit({ clientOrderId: 'b' }));
    for (let i = 0; i < 10; i++) await flush();
    expect(h.kuru.writes()).toHaveLength(1);

    // A read, and another agent's write, are not held behind it.
    expect((await h.call('get_balances', { venue: 'kuru' })).ok).toBe(true);
    const bob = testAgent({ id: '22222222-2222-4222-8222-222222222222', walletId: 'wallet-2' });
    await h.store.insert({ ...bob, mcpTokenHash: 'b'.repeat(64) });
    const bobCtx = h.tools.context(bob);
    await h.thesis(MON_USDC, bobCtx);
    expect(
      (await h.call('cancel_order', { venue: 'kuru', market: MON_USDC, orderId: '0:9' }, bobCtx))
        .ok,
    ).toBe(true);

    release();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(maxActive).toBe(1);
    expect(
      h.kuru.writes().map((c) => (c.args as { clientOrderId?: string }).clientOrderId ?? c.method),
    ).toEqual(['a', 'cancel', 'b']);
  });

  it('writes an event with the right layer for every refusal', async () => {
    const h = await harness();
    await h.call('place_limit', limit({ size: 1 })); // invalid input
    await h.call('place_limit', limit()); // no thesis
    await h.thesis();
    await h.call('place_limit', limit({ size: '100' })); // over the cap
    h.kuru.onWrite = () =>
      Promise.reject(
        new EnclaveRefusedError({ walletId: 'wallet-1', method: 'eth_signTransaction' }),
      );
    await h.call('place_limit', limit()); // passes layer 1, refused by the enclave

    const refusals = await h.refusals();
    expect(refusals.map((e) => [e.layer, e.detail['code']])).toEqual([
      ['sente', 'invalid_input'],
      ['sente', 'thesis_required'],
      ['sente', 'notional_over_cap'],
      ['enclave', 'policy_violation'],
    ]);
    expect(refusals.every((e) => e.runId === 'run-1' && e.tool === 'place_limit')).toBe(true);
  });

  it('records the thesis, each order, and each fill', async () => {
    const h = await harness();
    await h.thesis();
    await h.call('place_market', {
      venue: 'kuru',
      market: MON_USDC,
      side: 'buy',
      size: '10',
      slippageLimitPrice: '3.6',
    });
    await h.call('place_limit', limit()); // rests: an order, no fill

    const events = await h.events.list(h.agent.id);
    expect(events.map((e) => e.kind)).toEqual(['thesis', 'order', 'fill', 'order']);
    expect(events[0]!.detail).toMatchObject({ market: MON_USDC, direction: 'long' });
    expect(events[1]!.detail).toMatchObject({
      status: 'ok',
      precheck: true,
      intent: { venue: 'kuru', kind: 'order', notional: '36' },
    });
    expect(events[2]!.detail).toMatchObject({
      symbol: MON_USDC,
      filledSize: '10',
      averageFillPrice: '3.6',
    });
    expect(events.every((e) => e.agentId === h.agent.id && e.runId === 'run-1')).toBe(true);
  });

  it('returns a venue error as its reason, with no stack and no token', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.onWrite = () =>
      Promise.reject(
        new Error('Kuru said no (sente_mcp_abcDEF123)\n    at secret (/src/x.ts:1:1)'),
      );

    const outcome = refused(await h.call('place_limit', limit()));
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.message).toBe('Venue error: Kuru said no (sente_mcp_[redacted])');
    const [order] = await h.events.list(h.agent.id, { kind: 'order' });
    expect(order!.detail).toMatchObject({ status: 'failed', error: outcome.message });
  });

  it('sets Perpl leverage before the order, and says so when Perpl is not set up', async () => {
    const h = await harness();
    await h.thesis(BTC_PERP);
    const order = {
      venue: 'perpl',
      market: BTC_PERP,
      side: 'buy',
      size: '0.001',
      price: '60000',
      leverage: 3,
    };
    expect((await h.call('place_limit', order)).ok).toBe(true);
    expect(h.perpl.writes().map((c) => c.method)).toEqual(['setLeverage', 'placeLimit']);
    expect(h.perpl.writes()[0]!.args).toEqual({ symbol: BTC_PERP, leverage: 3 });

    const bare = await harness({ perpl: false });
    await bare.thesis(BTC_PERP);
    expect(refused(await bare.call('place_limit', order)).message).toMatch(
      /^Venue error: Perpl is not set up for this agent/,
    );
  });

  it('refuses Perpl-only fields on Kuru', async () => {
    const h = await harness();
    await h.thesis();
    const outcome = refused(await h.call('place_limit', limit({ leverage: 2 })));
    expect(outcome.refusal?.code).toBe('invalid_input');
    expect(h.kuru.writes()).toEqual([]);
  });

  it('deposits a side of the market, within the cap and the token precision', async () => {
    const h = await harness();
    await h.thesis();

    const ok = await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '25' });
    expect(ok.ok).toBe(true);
    expect(h.kuru.writes()).toEqual([{ method: 'deposit', args: { asset: 'USDC', amount: '25' } }]);

    const wrongAsset = refused(
      await h.call('deposit', { market: MON_USDC, asset: 'WETH', amount: '1' }),
    );
    expect(wrongAsset.refusal?.code).toBe('invalid_input');
    const tooPrecise = refused(
      await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '0.0000001' }),
    );
    expect(tooPrecise.refusal?.code).toBe('invalid_input');
    // MON is a side of the market but has no deposit cap in this mandate.
    const uncapped = refused(
      await h.call('deposit', { market: MON_USDC, asset: 'MON', amount: '1' }),
    );
    expect(uncapped.refusal?.code).toBe('market_not_allowed');
    expect(h.kuru.writes()).toHaveLength(1);
  });

  it('get_mandate gives the model symbols and human amounts, as JSON', async () => {
    const h = await harness();
    const outcome = await h.call('get_mandate', {});
    if (!outcome.ok) throw new Error(outcome.message);
    const mandate = JSON.parse(toResultText(outcome.result)) as {
      kuru: { markets: { symbol: string }[]; deposits: unknown[] };
      perpl: unknown;
      maxOrderNotional: string;
      secondsLeft: number;
      raw: { kuru: { maxDepositAtoms: Record<string, string> } };
    };

    expect(mandate.kuru.markets[0]!.symbol).toBe(MON_USDC);
    expect(mandate.kuru.deposits).toEqual([{ asset: 'USDC', maxPerDeposit: '1000' }]);
    expect(mandate.perpl).toMatchObject({
      markets: [BTC_PERP],
      maxLeverage: 5,
      maxCollateralAUSD: '500',
    });
    expect(mandate.maxOrderNotional).toBe('250');
    expect(mandate.secondsLeft).toBe(EXPIRES_AT - NOW);
    expect(Object.values(mandate.raw.kuru.maxDepositAtoms)).toEqual(['1000000000']);
  });
});

describe('venue pre-flight (SEN-19)', () => {
  const minMarket = {
    symbol: MON_USDC,
    kind: 'spot' as const,
    base: 'MON',
    quote: 'USDC',
    tickSize: '0.00001',
    stepSize: '0.00000001',
    minSize: '0.00000001',
    minNotional: '10',
  };

  it('refuses a deposit larger than the wallet holds, and signs nothing', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.wallet = [{ asset: 'USDC', available: '6', locked: '0', total: '6' }];

    const outcome = refused(await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '10' }));

    expect(outcome.refusal).toEqual({ layer: 'sente', code: 'insufficient_balance' });
    expect(outcome.message).toContain('Your wallet holds 6 USDC');
    expect(h.kuru.writes()).toHaveLength(0);
  });

  it('refuses a Kuru buy that AccountCore cannot back, pointing at deposit', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.balances = [{ asset: 'USDC', available: '0', locked: '0', total: '0' }];

    const outcome = refused(await h.call('place_limit', limit()));

    expect(outcome.refusal).toEqual({ layer: 'sente', code: 'insufficient_balance' });
    expect(outcome.message).toContain('Deposit first');
    expect(h.kuru.writes()).toHaveLength(0);
  });

  it('refuses a Kuru sell that AccountCore holds too little base for', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.balances = [{ asset: 'MON', available: '2', locked: '0', total: '2' }];

    const outcome = refused(await h.call('place_limit', limit({ side: 'sell', size: '5' })));

    expect(outcome.refusal?.code).toBe('insufficient_balance');
    expect(h.kuru.writes()).toHaveLength(0);
  });

  it("refuses an order below Kuru's minimum notional", async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.markets = [minMarket];

    const outcome = refused(await h.call('place_limit', limit({ size: '1', price: '3.5' })));

    expect(outcome.refusal).toEqual({ layer: 'sente', code: 'below_min_notional' });
    expect(outcome.message).toContain('minimum order on');
    expect(h.kuru.writes()).toHaveLength(0);
  });

  it('lets a backed order at or above the minimum through', async () => {
    const h = await harness();
    await h.thesis();
    h.kuru.markets = [minMarket];

    expect((await h.call('place_limit', limit({ size: '3', price: '3.5' }))).ok).toBe(true);
    expect(h.kuru.writes().map((w) => w.method)).toEqual(['placeLimit']);
  });

  it('does not run with the pre-check off, so the enclave demo still reaches the enclave', async () => {
    const h = await harness({ precheck: false });
    await h.thesis();
    h.kuru.wallet = [{ asset: 'USDC', available: '0', locked: '0', total: '0' }];
    h.kuru.balances = [];

    expect((await h.call('deposit', { market: MON_USDC, asset: 'USDC', amount: '1' })).ok).toBe(true);
    expect((await h.call('place_limit', limit())).ok).toBe(true);
    expect(h.kuru.writes().map((w) => w.method)).toEqual(['deposit', 'placeLimit']);
  });

  it('shows the wallet next to AccountCore in get_balances', async () => {
    const h = await harness();
    h.kuru.wallet = [{ asset: 'USDC', available: '6', locked: '0', total: '6' }];

    const outcome = await h.call('get_balances', { venue: 'kuru' });

    expect(outcome.ok).toBe(true);
    const [kuru] = (outcome as { result: unknown[] }).result as Array<Record<string, unknown>>;
    expect(kuru).toMatchObject({ venue: 'kuru', available: true });
    expect(kuru.wallet).toEqual([{ asset: 'USDC', available: '6', locked: '0', total: '6' }]);
  });
});
