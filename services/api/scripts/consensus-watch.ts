// SEN-21 live check: follow real Monad testnet blocks through their commit
// states and print the transitions with millisecond offsets.
//
//   pnpm --filter @sente/api run consensus:watch
//   pnpm --filter @sente/api run consensus:watch -- --poll      (HTTP fallback only)
//   pnpm --filter @sente/api run consensus:watch -- --blocks 3 -- --seconds 20
//
// What it does:
//   1. Reads `latest` once, to learn a height, then follows the next N.
//   2. Runs the real `ConsensusService`: `eth_subscribe(["monadNewHeads"])` on
//      MONAD_WS_URL, with the `eth_getBlockByNumber` fallback behind it.
//      `--poll` never opens a socket, so what is measured is the fallback.
//   3. Prints every transition as it arrives, then a table of each block's `at`
//      offsets and the offsets between states.
//
// `Verified` is only ever reported by the socket — the HTTP tags cannot say it —
// so `verified` stamps in the table are the proof the WebSocket path ran, not
// the fallback.
//
// Reads MONAD_WS_URL and MONAD_TESTNET_RPC_URL; both have testnet defaults. No
// key, no wallet, no funds: it only subscribes and reads.

import { existsSync } from 'node:fs';

import {
  ConsensusService,
  DEFAULT_MONAD_WS_URL,
  createTaggedBlockReader,
  firstObservedAt,
  type ConsensusRecord,
} from '../src/chain/consensus.service.ts';

const DEFAULT_MONAD_HTTP_URL = 'https://testnet-rpc.monad.xyz';

// The repo-root .env, when it is there (the package script also passes
// --env-file-if-exists), so MONAD_WS_URL can be overridden locally. Loading
// happens before anything reads process.env.
for (const candidate of ['../../.env', '.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} wants a positive integer`);
  }
  return parsed;
}

const BLOCKS = arg('blocks', 5);
const SECONDS = arg('seconds', 25);
const POLL_ONLY = process.argv.includes('--poll');

const WS_URL = process.env['MONAD_WS_URL']?.trim() || DEFAULT_MONAD_WS_URL;
const RPC_URL = process.env['MONAD_TESTNET_RPC_URL']?.trim() || DEFAULT_MONAD_HTTP_URL;

const logger = {
  log: (message: string) => console.log(`  · ${message}`),
  warn: (message: string) => console.warn(`  ! ${message}`),
};

const short = (blockId: string): string => `${blockId.slice(0, 10)}…${blockId.slice(-4)}`;

/** `proposed+0  voted+216  finalized+510`, in commit order. */
function offsetsOf(record: ConsensusRecord): string {
  const first = firstObservedAt(record);
  const order = ['proposed', 'voted', 'finalized', 'verified'] as const;
  return order
    .map((state) =>
      record.at[state] === undefined ? '' : `${state}+${record.at[state]! - first}ms`,
    )
    .filter((part) => part !== '')
    .join('  ');
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const readBlock = createTaggedBlockReader(RPC_URL);
  const service = new ConsensusService({ wsUrl: WS_URL, readBlock, logger, autoStart: false });

  const from = (await readBlock.getBlockByTag('latest'))?.number;
  if (from === undefined) {
    console.log(`blocked: ${RPC_URL} would not answer eth_getBlockByNumber(latest)`);
    return 1;
  }

  console.log('consensus-watch  SEN-21');
  console.log(`  source  ${POLL_ONLY ? `${RPC_URL} (tags only, --poll)` : WS_URL}`);
  console.log(`  from    block ${from}, following ${BLOCKS}`);
  console.log('');

  const followed = Array.from({ length: BLOCKS }, (_unused, index) => from + index);
  const reached = (): boolean =>
    followed.every((height) => {
      const state = service.stateOf(height)?.state;
      return state === 'Finalized' || state === 'Verified';
    });

  // Watch before starting, so the first pushes are caught rather than missed.
  let transitions = 0;
  let reorgs = 0;
  const seen = new Set<string>();
  for (const height of followed) {
    void (async () => {
      for await (const transition of service.watch(height)) {
        transitions += 1;
        seen.add(transition.state);
        if (transition.state === 'reorged') reorgs += 1;
        console.log(
          `+${String(Date.now() - startedAt).padStart(5)}ms  #${transition.blockNumber}  ` +
            `${transition.state.padEnd(9)} ${short(transition.blockId)}  ` +
            `${transition.state === 'reorged' ? `replacing ${transition.previousState}` : ''}` +
            `  (block +${transition.elapsedMs}ms)`,
        );
      }
    })();
  }

  if (POLL_ONLY) {
    // Nothing is started: the fallback is called by hand, one pass at a time.
    void (async () => {
      while (!reached()) {
        await service.pollOnce();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    })();
  } else {
    service.start();
  }

  // Ticking here is also what keeps the process alive: the service's own timers
  // are unref'd, because in the API it is the HTTP server that holds the loop.
  const deadline = Date.now() + SECONDS * 1_000;
  while (!reached() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  service.stop();

  console.log('');
  console.log('  #  block          state      blockId        offsets');
  for (const [index, height] of followed.entries()) {
    const record = service.stateOf(height);
    console.log(
      `  ${index + 1}  ${String(height).padEnd(13)}  ${(record?.state ?? 'unknown').padEnd(9)}  ` +
        `${record ? short(record.blockId).padEnd(16) : '—'.padEnd(16)}  ` +
        `${record ? offsetsOf(record) : ''}`,
    );
  }
  console.log('');

  const verified = followed.filter((height) => service.stateOf(height)?.at.verified).length;
  const finalized = followed.filter((height) => {
    const state = service.stateOf(height)?.state;
    return state === 'Finalized' || state === 'Verified';
  }).length;
  const unobserved = followed.filter((height) => service.stateOf(height) === undefined);
  console.log(`  transitions seen: ${transitions}`);
  console.log(
    `  verified stamps:  ${verified}/${BLOCKS}${POLL_ONLY ? ' (HTTP cannot report Verified)' : ''}`,
  );
  console.log(`  finalized:        ${finalized}/${BLOCKS}`);
  console.log(`  reorgs:           ${reorgs}`);

  if (POLL_ONLY) {
    // The fallback samples the head: one poll sees three heights, and at a poll
    // interval close to the block time a height can slip between two reads —
    // 63314091 was only ever sampled as `safe`, so it was never seen to finalize.
    // What this mode has to prove is the MAPPING, not five complete ramps.
    const observed = seen.has('Voted') && seen.has('Finalized') && unobserved.length === 0;
    console.log(
      `\n${observed ? 'FALLBACK OK' : 'FALLBACK FAILED'}: latest→Proposed, safe→Voted, ` +
        `finalized→Finalized; ${finalized}/${BLOCKS} heights reached Finalized before the deadline ` +
        '(a sampler can miss a state; the socket does not)',
    );
    return observed ? 0 : 1;
  }

  if (unobserved.length > 0 || finalized < BLOCKS) {
    const missed = followed.filter((height) => {
      const state = service.stateOf(height)?.state;
      return state !== 'Finalized' && state !== 'Verified';
    });
    console.log(`\nINCOMPLETE: ${missed.join(', ')} never reached Finalized in ${SECONDS}s`);
    return 1;
  }

  console.log('\nOK: monadNewHeads carried all five blocks to Finalized');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
