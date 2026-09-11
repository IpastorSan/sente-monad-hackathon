/**
 * The agent's tools, each defined ONCE: a zod schema, a kind, and a handler.
 * `gate.ts` wraps them; `anthropic.ts` and `mcp.ts` expose the gated tools to
 * the Tool Runner and to MCP clients. Nothing here enforces the mandate — the
 * gate does, before a handler ever runs.
 *
 * A write tool can declare two hooks the gate reads:
 * - `thesisMarket`: the market whose `record_thesis` must already be on record
 *   in this run. Cancel and close have none: reducing risk is never gated.
 * - `intent`: what `checkIntent` (layer 1) judges.
 */
import { type Intent, type Mandate } from '@sente/mandate';
import type { Decimal, Side } from '@sente/venues';
import {
  fromUnits,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  toUnits,
  type KuruToken,
} from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS } from '@sente/venues/perpl';
import { isAddressEqual } from 'viem';
import * as z from 'zod/v4';

import { toMandateDto } from '../dto/agent.dto';
import type { AgentRecord } from '../store/agent-store';
import type { KuruToolVenue, ToolContext, ToolVenues } from './context';
import { isPositiveDecimal, maxDecimal, mulDecimal } from './decimal';
import { invalidInput } from './refusals';

export type ToolKind = 'read' | 'write';

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly kind: ToolKind;
  thesisMarket?(args: z.output<S>): string;
  intent?(ctx: ToolContext, args: z.output<S>): Promise<Intent>;
  handler(ctx: ToolContext, args: z.output<S>): Promise<unknown>;
}

function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool as AgentTool;
}

// ---------------------------------------------------------------------------
// Shared schemas

const VENUE_IDS = ['kuru', 'perpl'] as const;
type ToolVenueId = (typeof VENUE_IDS)[number];

const venue = z
  .enum(VENUE_IDS)
  .describe('"kuru" is Kuru spot order books; "perpl" is Perpl perpetual futures.');
const market = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'a market symbol such as "MON-USDC" or "BTC-PERP"')
  .describe('Market symbol, e.g. "MON-USDC" on Kuru or "BTC-PERP" on Perpl.');
const decimal = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'a plain decimal string such as "12.5": no sign or exponent');
const positive = decimal.refine(isPositiveDecimal, 'must be greater than zero');
const side = z.enum(['buy', 'sell']);
const leverage = z
  .number()
  .positive()
  .max(100)
  .describe('Perpl only, and required there: leverage for this order, e.g. 3 for 3x.');
const reduceOnly = z
  .boolean()
  .describe('Perpl only: only ever reduce an open position, never open or flip one.');
const clientOrderId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .describe('Your own idempotency key for this order.');

// ---------------------------------------------------------------------------
// Helpers

export class VenueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueUnavailableError';
  }
}

function requirePerpl(venues: ToolVenues) {
  if (!venues.perpl) {
    throw new VenueUnavailableError(
      'Perpl is not set up for this agent yet: its wallet has not enrolled a Perpl API key',
    );
  }
  return venues.perpl;
}

function venueOf(venues: ToolVenues, id: ToolVenueId) {
  return id === 'kuru' ? venues.kuru : requirePerpl(venues);
}

/**
 * What `checkIntent` calls the market: the OrderBook address on Kuru, the
 * symbol on Perpl. An unknown Kuru symbol stays a symbol, which the mandate
 * refuses as `market_not_allowed` rather than as a venue error.
 */
function mandateMarket(venues: ToolVenues, id: ToolVenueId, symbol: string): string {
  if (id !== 'kuru') return symbol;
  try {
    return venues.kuru.market(symbol).address;
  } catch {
    return symbol;
  }
}

/**
 * Order notional in quote units, as the cap should see it. A buy never pays
 * more than `size × price` (the limit price, or the slippage ceiling). A sell's
 * price is a FLOOR, so `size × price` could be made arbitrarily small; it is
 * valued at the higher of that and the book's own price for the size.
 */
async function orderNotional(
  venues: ToolVenues,
  id: ToolVenueId,
  args: { market: string; side: Side; size: Decimal },
  price: Decimal,
): Promise<Decimal> {
  const atPrice = mulDecimal(args.size, price);
  if (args.side === 'buy') return atPrice;
  const quote = await venueOf(venues, id).quote({
    symbol: args.market,
    side: 'sell',
    size: args.size,
  });
  return isPositiveDecimal(quote.averagePrice)
    ? maxDecimal(atPrice, mulDecimal(args.size, quote.averagePrice))
    : atPrice;
}

function orderIntent(
  venues: ToolVenues,
  args: { venue: ToolVenueId; market: string; leverage?: number | undefined },
  notional: Decimal,
): Intent {
  return {
    venue: args.venue,
    kind: 'order',
    market: mandateMarket(venues, args.venue, args.market),
    notional,
    ...(args.leverage !== undefined ? { leverage: args.leverage } : {}),
  };
}

function spotOnlyChecks(args: {
  venue: ToolVenueId;
  leverage?: number | undefined;
  reduceOnly?: boolean | undefined;
}) {
  if (args.venue === 'kuru' && (args.leverage !== undefined || args.reduceOnly !== undefined)) {
    throw invalidInput('leverage and reduceOnly apply to Perpl only; Kuru is spot');
  }
}

function depositToken(kuru: KuruToolVenue, args: { market: string; asset: string }): KuruToken {
  let config;
  try {
    config = kuru.market(args.market);
  } catch {
    throw invalidInput(`Kuru does not list ${args.market}`);
  }
  const token = [config.base, config.quote].find((t) => t.symbol === args.asset);
  if (!token) {
    throw invalidInput(
      `${args.asset} is not traded on ${args.market}; deposit ${config.base.symbol} or ` +
        `${config.quote.symbol}`,
    );
  }
  return token;
}

function atoms(amount: Decimal, token: KuruToken): bigint {
  try {
    return toUnits(amount, token.decimals, 'amount');
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : String(error));
  }
}

async function currentMandate(ctx: ToolContext): Promise<{ agent: AgentRecord; mandate: Mandate }> {
  const agent = (await ctx.currentAgent()) ?? ctx.agent;
  return { agent, mandate: agent.mandate };
}

const KURU_TOKENS = Object.values(KURU_TESTNET_TOKENS);

/**
 * The mandate as the model should read it: symbols and human amounts next to
 * the raw form. `get_mandate` returns it, and the runner's system prompt
 * renders it (SEN-8).
 */
export function describeMandate(agent: AgentRecord, now: number) {
  const { mandate } = agent;
  const kuruMarkets = mandate.kuru.markets.map((address) => ({
    symbol: KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address))?.symbol,
    address,
  }));
  const kuruDeposits = Object.entries(mandate.kuru.maxDepositAtoms).map(([address, cap]) => {
    const token = KURU_TOKENS.find((t) => isAddressEqual(t.address, address as `0x${string}`));
    return {
      asset: token?.symbol ?? address,
      maxPerDeposit: token ? fromUnits(cap, token.decimals) : cap.toString(),
    };
  });
  return {
    agentId: agent.id,
    status: agent.status,
    expiresAt: new Date(mandate.expiresAt * 1000).toISOString(),
    secondsLeft: Math.max(0, mandate.expiresAt - now),
    venues: mandate.venues,
    maxOrderNotional: mandate.maxOrderNotional,
    kuru: { markets: kuruMarkets, deposits: kuruDeposits },
    perpl: {
      markets: mandate.perpl.markets,
      maxLeverage: mandate.perpl.maxLeverage,
      maxCollateralAUSD: fromUnits(mandate.perpl.maxCollateralAtoms, PERPL_COLLATERAL_DECIMALS),
    },
    rules: [
      'Call record_thesis for a market before any place_limit, place_market or deposit on it.',
      'maxOrderNotional caps every single order in quote units: size x price (a market order ' +
        'at its slippage bound; a sell at no less than the book price).',
      'cancel_order and close_position are always allowed on a venue you may use.',
      'The Privy enclave independently refuses to sign anything outside the mandate.',
    ],
    raw: toMandateDto(mandate),
  };
}

// ---------------------------------------------------------------------------
// Read tools

const getMandate = defineTool({
  name: 'get_mandate',
  kind: 'read',
  description:
    'Your mandate: the only venues and markets you may trade, the largest order, the ' +
    'leverage and deposit caps, and when it expires. Anything outside it is refused. ' +
    'Call this first.',
  input: z.strictObject({}),
  async handler(ctx) {
    const { agent } = await currentMandate(ctx);
    return describeMandate(agent, ctx.now());
  },
});

const listMarkets = defineTool({
  name: 'list_markets',
  kind: 'read',
  description:
    'Markets on each venue, with tick size, step size and minimum size, and whether your ' +
    'mandate allows trading each one.',
  input: z.strictObject({ venue: venue.optional() }),
  async handler(ctx, args) {
    const [{ mandate }, venues] = await Promise.all([currentMandate(ctx), ctx.venues()]);
    const ids = args.venue ? [args.venue] : VENUE_IDS;
    return Promise.all(
      ids.map(async (id) => {
        const v = id === 'kuru' ? venues.kuru : venues.perpl;
        if (!v) return { venue: id, available: false, reason: 'Perpl is not set up yet' };
        const markets = await v.getMarkets();
        return {
          venue: id,
          available: true,
          venueAllowed: mandate.venues.includes(id),
          markets: markets.map((m) => ({
            ...m,
            allowed:
              mandate.venues.includes(id) &&
              (id === 'kuru'
                ? mandate.kuru.markets.some(
                    (a) => a.toLowerCase() === mandateMarket(venues, id, m.symbol).toLowerCase(),
                  )
                : mandate.perpl.markets.includes(m.symbol)),
          })),
        };
      }),
    );
  },
});

const getDepth = defineTool({
  name: 'get_depth',
  kind: 'read',
  description: 'The order book for one market: bids best first, asks best first.',
  input: z.strictObject({
    venue,
    market,
    limit: z.number().int().min(1).max(50).optional().describe('Levels per side; default 10.'),
  }),
  async handler(ctx, args) {
    const v = venueOf(await ctx.venues(), args.venue);
    return v.getDepth({ symbol: args.market, limit: args.limit ?? 10 });
  },
});

const getBalances = defineTool({
  name: 'get_balances',
  kind: 'read',
  description:
    'Your balances at each venue: Kuru AccountCore balances (available and locked by resting ' +
    'orders) and Perpl collateral.',
  input: z.strictObject({ venue: venue.optional() }),
  async handler(ctx, args) {
    const venues = await ctx.venues();
    const ids = args.venue ? [args.venue] : VENUE_IDS;
    return Promise.all(
      ids.map(async (id) => {
        const v = id === 'kuru' ? venues.kuru : venues.perpl;
        if (!v) return { venue: id, available: false, reason: 'Perpl is not set up yet' };
        return { venue: id, available: true, balances: await v.getBalances() };
      }),
    );
  },
});

const getPositions = defineTool({
  name: 'get_positions',
  kind: 'read',
  description: 'Your open Perpl positions, optionally for one market.',
  input: z.strictObject({ market: market.optional() }),
  async handler(ctx, args) {
    return requirePerpl(await ctx.venues()).getPositions(args.market);
  },
});

const getOpenOrders = defineTool({
  name: 'get_open_orders',
  kind: 'read',
  description: 'Your orders still working on one venue, optionally for one market.',
  input: z.strictObject({ venue, market: market.optional() }),
  async handler(ctx, args) {
    return venueOf(await ctx.venues(), args.venue).getOpenOrders(args.market);
  },
});

// ---------------------------------------------------------------------------
// Write tools

const recordThesis = defineTool({
  name: 'record_thesis',
  kind: 'write',
  description:
    'Write down why you are about to trade a market and what would prove you wrong. Required ' +
    'before any place_limit, place_market or deposit on that market in this run. Recording ' +
    'again replaces your thesis for that market.',
  input: z.strictObject({
    market,
    direction: z.enum(['long', 'short']),
    thesis: z.string().min(1).max(2000).describe('Why this trade, now.'),
    invalidation: z
      .string()
      .min(1)
      .max(1000)
      .describe('What would prove the thesis wrong, and what you will do then.'),
  }),
  async handler(ctx, args) {
    const recorded = { ...args, at: Date.now() };
    ctx.theses.set(args.market, recorded);
    await ctx.events.append({
      agentId: ctx.agent.id,
      runId: ctx.runId,
      kind: 'thesis',
      tool: 'record_thesis',
      detail: recorded,
    });
    return { recorded: true, market: args.market, direction: args.direction };
  },
});

const placeLimit = defineTool({
  name: 'place_limit',
  kind: 'write',
  description:
    'Place a limit order. Its notional (size x price) must be within your mandate. On Perpl, ' +
    'leverage is required.',
  input: z.strictObject({
    venue,
    market,
    side,
    size: positive.describe('Base units, e.g. "0.5".'),
    price: positive.describe('Limit price in quote units, on the market tick.'),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'POST_ONLY']).optional(),
    leverage: leverage.optional(),
    reduceOnly: reduceOnly.optional(),
    clientOrderId: clientOrderId.optional(),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    return orderIntent(venues, args, await orderNotional(venues, args.venue, args, args.price));
  },
  async handler(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const request = {
      symbol: args.market,
      side: args.side,
      size: args.size,
      price: args.price,
      timeInForce: args.timeInForce,
      reduceOnly: args.reduceOnly,
      clientOrderId: args.clientOrderId,
    };
    if (args.venue === 'kuru') return venues.kuru.placeLimit(request);
    const perpl = requirePerpl(venues);
    if (args.leverage !== undefined) {
      await perpl.setLeverage({ symbol: args.market, leverage: args.leverage });
    }
    return perpl.placeLimit(request);
  },
});

const placeMarket = defineTool({
  name: 'place_market',
  kind: 'write',
  description:
    'Place a market order that fills now or not at all, bounded by slippageLimitPrice: the ' +
    'worst price you accept (a ceiling for a buy, a floor for a sell). The bound is required. ' +
    'On Perpl, leverage is required.',
  input: z.strictObject({
    venue,
    market,
    side,
    size: positive.describe('Base units, e.g. "0.5".'),
    slippageLimitPrice: positive.describe('Worst acceptable execution price. Required.'),
    leverage: leverage.optional(),
    reduceOnly: reduceOnly.optional(),
    clientOrderId: clientOrderId.optional(),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const notional = await orderNotional(venues, args.venue, args, args.slippageLimitPrice);
    return orderIntent(venues, args, notional);
  },
  async handler(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const request = {
      symbol: args.market,
      side: args.side,
      size: args.size,
      slippageLimitPrice: args.slippageLimitPrice,
      reduceOnly: args.reduceOnly,
      clientOrderId: args.clientOrderId,
    };
    if (args.venue === 'kuru') return venues.kuru.placeMarket(request);
    const perpl = requirePerpl(venues);
    if (args.leverage !== undefined) {
      await perpl.setLeverage({ symbol: args.market, leverage: args.leverage });
    }
    return perpl.placeMarket(request);
  },
});

const deposit = defineTool({
  name: 'deposit',
  kind: 'write',
  description:
    'Move funds from your wallet into your Kuru AccountCore balance, so orders on a Kuru ' +
    'market can use them. Within the per-deposit cap of your mandate.',
  input: z.strictObject({
    market: market.describe('The Kuru market this deposit funds, e.g. "MON-USDC".'),
    asset: z
      .string()
      .min(1)
      .max(16)
      .describe('The token: that market\'s base or quote, e.g. "USDC".'),
    amount: positive.describe('Human units, e.g. "25" for 25 USDC.'),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    const { kuru } = await ctx.venues();
    const token = depositToken(kuru, args);
    return {
      venue: 'kuru',
      kind: 'deposit',
      market: token.address,
      amountAtoms: atoms(args.amount, token),
    };
  },
  async handler(ctx, args) {
    const { kuru } = await ctx.venues();
    const token = depositToken(kuru, args);
    atoms(args.amount, token); // precision, before anything is signed
    const execution = await kuru.deposit(token.symbol, args.amount);
    return {
      deposited: args.amount,
      asset: token.symbol,
      hash: execution.hash,
      transactionHash: execution.transactionHash,
    };
  },
});

const cancelOrder = defineTool({
  name: 'cancel_order',
  kind: 'write',
  description:
    'Cancel one of your resting orders. Always allowed, with no thesis needed: reducing risk ' +
    'is never blocked. Cancelling an order that already finished reports how it ended.',
  input: z.strictObject({
    venue,
    market,
    orderId: z.string().min(1).max(100).describe('The id returned when the order was placed.'),
  }),
  async intent(ctx, args) {
    const venues = await ctx.venues();
    return {
      venue: args.venue,
      kind: 'cancel',
      market: mandateMarket(venues, args.venue, args.market),
    };
  },
  async handler(ctx, args) {
    return venueOf(await ctx.venues(), args.venue).cancel({
      symbol: args.market,
      orderId: args.orderId,
    });
  },
});

const closePosition = defineTool({
  name: 'close_position',
  kind: 'write',
  description:
    'Close a Perpl position, fully or partly, with a reduce-only order that can never flip it. ' +
    'Always allowed, with no thesis needed.',
  input: z.strictObject({
    market,
    size: positive.optional().describe('Base units to close; omit to close all of it.'),
    slippageLimitPrice: positive
      .optional()
      .describe('Worst acceptable price; omit for the venue default bound.'),
  }),
  async intent(_ctx, args) {
    return { venue: 'perpl', kind: 'close', market: args.market };
  },
  async handler(ctx, args) {
    return requirePerpl(await ctx.venues()).closePosition({
      symbol: args.market,
      size: args.size,
      slippageLimitPrice: args.slippageLimitPrice,
    });
  },
});

/** Every tool, reads first. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getMandate,
  listMarkets,
  getDepth,
  getBalances,
  getPositions,
  getOpenOrders,
  recordThesis,
  placeLimit,
  placeMarket,
  deposit,
  cancelOrder,
  closePosition,
];
