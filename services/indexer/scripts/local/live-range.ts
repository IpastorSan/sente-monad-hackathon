/**
 * Run the REAL handlers over a REAL range of Monad testnet blocks, in memory.
 *
 *   ENVIO_API_TOKEN=placeholder mise exec -- node --experimental-strip-types \
 *     --no-warnings scripts/local/live-range.ts <startBlock> [endBlock]
 *
 * No Postgres, no Envio account, no `envio dev`: `createTestIndexer()` runs the
 * registered handlers against the sources in `config.yaml` and keeps the
 * entities in memory, so a single block can be checked in a few seconds and the
 * output diffed against the chain by hand. This is what produced every figure
 * in docs/indexer.md §"Proven live runs", and re-running it is how you check
 * that a change to the handlers still agrees with real logs — a unit test pins
 * the arithmetic, this pins the decoding of what the chain actually emits.
 *
 * TWO THINGS THAT LOOK BROKEN AND ARE NOT:
 *
 *   - `ENVIO_API_TOKEN` is required even though we have no HyperSync account.
 *     Envio builds the HyperSync source eagerly and `requireApiToken` throws
 *     before anything runs, so any non-empty string gets past it; the source
 *     then 401s, Envio falls back to the RPC in `config.yaml`, and the blocks
 *     are indexed anyway (docs/indexer.md §hypersync). This script fills the
 *     variable in itself so the failure cannot be mistaken for a real one.
 *   - Monad's public RPC caps `eth_getLogs` at 100 blocks, so a range wider
 *     than that is slow rather than wrong. Spot-check single blocks.
 *
 * Committed, unlike the rest of `scripts/local/`, because docs/indexer.md cites
 * it by name: a documented run nobody can reproduce is a claim, not evidence.
 */

// Every import here is dynamic, so this marks the file as a module (top-level
// await needs one) without also making `envio` load before the line below.
export {};

// Before `envio` is imported, hence the dynamic imports: the module reads this
// at load time and throws if it is missing.
process.env['ENVIO_API_TOKEN'] ||= 'placeholder';

const { createTestIndexer } = await import('envio');
// Registers the handlers on the `envio` singleton the test indexer runs.
await import('../../src/EventHandlers.ts');

const MONAD_TESTNET = 10143;

/**
 * Every entity in `schema.graphql`, in the order the summary prints them.
 * `@internal` entities (the two Perpl join tables) are included: they are how
 * the Perpl attribution is checked, and a zero there explains an empty Trade.
 */
const ENTITIES = [
  'Trade',
  'AccountMarketStats',
  'Account',
  'Market',
  'MarketDay',
  'MakerOrderUpdate',
  'AccountBalance',
  'PerplOrderContext',
  'PerplMakerFill',
] as const;

type EntityRow = Record<string, unknown>;
type EntityReader = { getAll: () => Promise<EntityRow[]> };

function usage(message: string): never {
  console.error(`${message}\nusage: live-range.ts <startBlock> [endBlock]`);
  process.exit(1);
}

function blockArg(raw: string | undefined, name: string): number {
  if (raw === undefined) usage(`missing ${name}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) usage(`${name} must be a block number, got "${raw}"`);
  return value;
}

/** Entity fields are bigint, BigDecimal or string; none of them print usefully by default. */
function show(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'object' && 'toFixed' in value)
    return (value as { toFixed(): string }).toFixed();
  return String(value);
}

/**
 * A market id carries a 42-character address, which is most of a line and none
 * of the information. Only the address is elided, so the rest of the id — the
 * account, the date — stays readable and greppable.
 */
function short(value: unknown): string {
  return show(value).replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`);
}

const startBlock = blockArg(process.argv[2], 'startBlock');
const endBlock = process.argv[3] === undefined ? startBlock : blockArg(process.argv[3], 'endBlock');
if (endBlock < startBlock) usage('endBlock is before startBlock');

const indexer = createTestIndexer() as unknown as Record<string, EntityReader> & {
  process(config: {
    chains: Record<number, { startBlock: number; endBlock: number }>;
  }): Promise<unknown>;
};

console.log(`indexing ${MONAD_TESTNET} blocks ${startBlock}..${endBlock} with the real handlers`);
await indexer.process({ chains: { [MONAD_TESTNET]: { startBlock, endBlock } } });

const rows = new Map<string, EntityRow[]>();
for (const name of ENTITIES) {
  const reader = indexer[name];
  if (reader === undefined) continue; // schema drifted; say nothing rather than crash
  rows.set(name, await reader.getAll());
}

console.log([...rows].map(([name, entities]) => `${name}=${entities.length}`).join(' '));

// A `@derivedFrom`/link field arrives as `<name>_id` holding the linked id, not
// as the entity — so `market_id`, not `market`.
for (const trade of rows.get('Trade') ?? []) {
  console.log(
    `  trade ${show(trade['id'])} ${show(trade['venue'])} ${short(trade['market_id'])} ` +
      `${show(trade['side'])} rawPrice=${show(trade['rawPrice'])} rawSize=${show(trade['rawSize'])} ` +
      `price=${show(trade['price'])} notional=${show(trade['notionalUsd'])} ` +
      `taker=${show(trade['taker_id'])} maker=${show(trade['maker_id'])}`,
  );
}

for (const stats of rows.get('AccountMarketStats') ?? []) {
  console.log(
    `  stats ${short(stats['id'])} n=${show(stats['n'])} takerN=${show(stats['takerN'])} ` +
      `makerN=${show(stats['makerN'])} vol=${show(stats['volumeUsd'])} ` +
      `open=${show(stats['openBaseRaw'])}/${show(stats['openCostRaw'])}`,
  );
}

// An account with no address cannot be matched to a Sente agent, so it is left
// off the leaderboard entirely — printing it is the point (docs §addresses).
for (const account of rows.get('Account') ?? []) {
  console.log(
    `  account ${show(account['id'])} ${show(account['venue'])} address=${show(account['address'])}`,
  );
}

for (const day of rows.get('MarketDay') ?? []) {
  console.log(
    `  day ${short(day['id'])} trades=${show(day['tradeCount'])} volumeUsd=${show(day['volumeUsd'])} ` +
      `baseVolume=${show(day['baseVolume'])} vwap=${show(day['vwapPrice'])}`,
  );
}

// Envio leaves its sources connected, so the process would hang here with the
// answer already printed. Nothing is persisted, so there is nothing to flush.
process.exit(0);
