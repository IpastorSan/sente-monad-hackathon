/**
 * Verify config.yaml against the chain.
 *
 * Every `event:` signature in config.yaml is recomputed to a topic0 and looked
 * for in recent logs from that contract's configured addresses. Two distinct
 * mistakes are caught, and neither is caught by `envio codegen`:
 *
 *   - a wrong signature → its topic0 matches nothing, so the event silently
 *     indexes zero rows forever;
 *   - a wrong `indexed` flag → the *topic count* of the real logs disagrees with
 *     the declared one, so envio decodes topics and data in the wrong places and
 *     writes plausible garbage.
 *
 * Perpl events are declared by bare name against `abi_file_path`; that ABI is
 * loaded here and the signatures are taken from it, so the check is the same.
 *
 * Usage (from services/indexer):
 *   mise exec -- npm run verify:topics            # 5 windows of 100 blocks
 *   mise exec -- npm run verify:topics -- 20      # 20 windows
 *   mise exec -- npm run verify:topics -- 20 0x…  # plus a specific block window
 *
 * `viem` is imported for its keccak256; it resolves through `envio`, which
 * depends on it. Monad's public RPC caps eth_getLogs at 100 blocks, which is
 * why this walks windows instead of asking for a range.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RPC = process.env.VERIFY_RPC ?? 'https://testnet-rpc.monad.xyz';
const WINDOW = 100;
const windows = Number(process.argv[2] ?? 5);

// ---------------------------------------------------------------- config.yaml

function stripComments(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Minimal reader for the two shapes this file uses. It is deliberately not a
 * YAML parser: it knows `- name:`, `address:`, `- event: "sig"` and
 * `- event: ThisName`, and would need extending before it understood anything
 * else. `envio codegen` remains the authority on whether the YAML is valid.
 */
function readConfig(text: string): {
  addresses: Map<string, string[]>;
  events: Map<string, string[]>;
  abiFiles: Map<string, string>;
} {
  const addresses = new Map<string, string[]>();
  const events = new Map<string, string[]>();
  const abiFiles = new Map<string, string>();
  let contract: string | undefined;

  for (const raw of text.split('\n')) {
    const line = stripComments(raw);
    if (line.trim() === '') continue;

    const name = /^\s*-\s*name:\s*(\S+)\s*$/.exec(line);
    if (name) {
      contract = name[1]!;
      if (!addresses.has(contract)) addresses.set(contract, []);
      if (!events.has(contract)) events.set(contract, []);
      continue;
    }
    if (contract === undefined) continue;

    const abi = /^\s*abi_file_path:\s*(\S+)\s*$/.exec(line);
    if (abi) {
      abiFiles.set(contract, abi[1]!);
      continue;
    }
    const addrList = /^\s*-\s*"(0x[0-9a-fA-F]{40})"\s*$/.exec(line);
    if (addrList) {
      addresses.get(contract)!.push(addrList[1]!.toLowerCase());
      continue;
    }
    const addrOne = /^\s*address:\s*"(0x[0-9a-fA-F]{40})"\s*$/.exec(line);
    if (addrOne) {
      addresses.get(contract)!.push(addrOne[1]!.toLowerCase());
      continue;
    }
    const quoted = /^\s*-\s*event:\s*"(.+)"\s*$/.exec(line);
    if (quoted) {
      events.get(contract)!.push(quoted[1]!);
      continue;
    }
    const bare = /^\s*-\s*event:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (bare) {
      events.get(contract)!.push(bare[1]!);
      continue;
    }
  }
  return { addresses, events, abiFiles };
}

/** `Deposit(uint40 indexed accountId, …)` → signature + how many are indexed. */
function parseSignature(declared: string): { signature: string; indexedCount: number } {
  const open = declared.indexOf('(');
  if (open === -1) throw new Error(`not a signature: ${declared}`);
  const name = declared.slice(0, open).trim();
  const inner = declared.slice(open + 1, declared.lastIndexOf(')'));
  const params = inner.trim() === '' ? [] : inner.split(',').map((p) => p.trim());
  let indexedCount = 0;
  const types = params.map((param) => {
    const parts = param.split(/\s+/);
    if (parts.includes('indexed')) {
      indexedCount += 1;
      return parts.filter((p) => p !== 'indexed')[0]!;
    }
    return parts[0]!;
  });
  return { signature: `${name}(${types.join(',')})`, indexedCount };
}

/** Resolve a bare `- event: Name` against the contract's abi_file_path. */
function signatureFromAbiFile(
  abiPath: string,
  eventName: string,
): { signature: string; indexedCount: number } | undefined {
  const abi: { type: string; name: string; inputs: { type: string; indexed?: boolean }[] }[] =
    JSON.parse(readFileSync(fileURLToPath(new URL(`../${abiPath}`, import.meta.url)), 'utf8'));
  const item = abi.find((i) => i.type === 'event' && i.name === eventName);
  if (item === undefined) return undefined;
  return {
    signature: `${item.name}(${item.inputs.map((i) => i.type).join(',')})`,
    indexedCount: item.inputs.filter((i) => i.indexed).length,
  };
}

// ------------------------------------------------------------------- rpc + topic0

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

let toEventSelector: (sig: string) => string;
try {
  ({ toEventSelector } = (await import('viem')) as { toEventSelector: (s: string) => string });
} catch {
  console.error(
    'viem is not resolvable. Run this from services/indexer after `npm install` ' +
      '(viem arrives as a dependency of envio).',
  );
  process.exit(2);
}

const config = readConfig(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8'));

type Declared = {
  readonly contract: string;
  readonly event: string;
  /** canonical signature, `indexed` stripped */
  readonly signature: string;
  readonly indexedCount: number;
  readonly addresses: readonly string[];
};

/** One row per (contract, event), with every address the contract is bound to. */
const declared: Declared[] = [];
for (const [contract, eventList] of config.events) {
  const abiPath = config.abiFiles.get(contract);
  for (const entry of eventList) {
    const parsed = entry.includes('(')
      ? parseSignature(entry)
      : abiPath === undefined
        ? undefined
        : signatureFromAbiFile(abiPath, entry);
    if (parsed === undefined) {
      console.warn(`! ${contract}.${entry}: no signature and no abi_file_path — skipped`);
      continue;
    }
    declared.push({
      contract,
      event: entry.includes('(') ? entry.slice(0, entry.indexOf('(')) : entry,
      signature: parsed.signature,
      indexedCount: parsed.indexedCount,
      addresses: config.addresses.get(contract) ?? [],
    });
  }
}

const head = Number(await rpc('eth_blockNumber', []));
console.log(`RPC ${RPC}`);
console.log(`head ${head}, scanning ${windows} window(s) of ${WINDOW} blocks\n`);

type Seen = { count: number; topicCounts: Map<number, number>; evidence: string[] };
const seen = new Map<string, Seen>();
const addresses = [...new Set(declared.flatMap((d) => [...d.addresses]))];

/** Merge a log into the tally. `label` records where it was seen. */
function record(address: string, topic0: string, topicCount: number, label: string): void {
  const key = `${address.toLowerCase()}:${topic0.toLowerCase()}`;
  const entry: Seen = seen.get(key) ?? { count: 0, topicCounts: new Map(), evidence: [] };
  entry.count += 1;
  entry.topicCounts.set(topicCount, (entry.topicCounts.get(topicCount) ?? 0) + 1);
  if (!entry.evidence.includes(label)) entry.evidence.push(label);
  seen.set(key, entry);
}

for (let w = 0; w < windows; w++) {
  const to = head - w * WINDOW;
  const from = to - (WINDOW - 1);
  const logs = (await rpc('eth_getLogs', [
    {
      address: addresses,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    },
  ])) as { address: string; topics: string[] }[];
  for (const log of logs) {
    record(log.address, log.topics[0]!, log.topics.length, 'recent');
  }
  console.log(`  window ${from}-${to}: ${logs.length} logs`);
}

/**
 * Rare events (a Kuru deposit, a Perpl AccountCreated) will not appear in any
 * few hundred recent blocks. These are the documented transactions that do
 * contain them — the same evidence docs/kuru.md and src/lib/perpl.ts cite — so
 * "no logs in range" is not the end of the check.
 */
const EVIDENCE_TXS = [
  {
    label: 'kuru fill 61406913',
    hash: '0x9d7fbce17b32fb4585612ed292ba064da5e85c0da865edee6dcfb2aefb2d30fd',
  },
  {
    label: 'kuru account id 62',
    hash: '0xf0b6ffc917e6965f4e4cb88ed602c018b38e01144f7219ae907c26620e9c1e9a',
  },
  {
    label: 'perpl btc close',
    hash: '0xd58c92adeb7a58603a8ccb14599477de289bb1f03148039328a018fc40aad070',
  },
] as const;

console.log('\nevidence transactions:');
for (const tx of EVIDENCE_TXS) {
  const receipt = (await rpc('eth_getTransactionReceipt', [tx.hash])) as {
    logs: { address: string; topics: string[] }[];
  };
  for (const log of receipt.logs) {
    record(log.address, log.topics[0]!, log.topics.length, tx.label);
  }
  console.log(`  ${tx.label}: ${receipt.logs.length} logs`);
}

console.log('\ndeclared event'.padEnd(44), 'topic0'.padEnd(10), 'idx  logs  topics  verdict');
/** A topic-count mismatch is a definite bug; "unobserved" is only a note. */
let mismatches = 0;
let unobserved = 0;
for (const d of declared) {
  const topic0 = toEventSelector(d.signature).toLowerCase();
  const expectedTopics = 1 + d.indexedCount;
  const label = `${d.contract}.${d.event}`;

  // Aggregate over every address this contract is bound to: one order book
  // being quiet says nothing about the signature.
  let count = 0;
  const topicCounts = new Map<number, number>();
  const evidence = new Set<string>();
  for (const address of d.addresses) {
    const hit = seen.get(`${address}:${topic0}`);
    if (hit === undefined) continue;
    count += hit.count;
    for (const [topics, n] of hit.topicCounts) {
      topicCounts.set(topics, (topicCounts.get(topics) ?? 0) + n);
    }
    for (const e of hit.evidence) evidence.add(e);
  }
  const counts = Object.fromEntries(topicCounts);
  const where = [...evidence].filter((e) => e !== 'recent');

  let verdict: string;
  if (count === 0) {
    unobserved += 1;
    verdict = 'unobserved (rare event, no logs found)';
  } else if (!topicCounts.has(expectedTopics)) {
    mismatches += 1;
    verdict = `MISMATCH: expected ${expectedTopics} topics, saw ${JSON.stringify(counts)}`;
  } else {
    verdict = `OK${where.length > 0 ? ` (${where.join(', ')})` : ''}`;
  }
  console.log(
    label.padEnd(44),
    topic0.slice(2, 12).padEnd(10),
    String(d.indexedCount).padEnd(4),
    String(count).padStart(4),
    ' ',
    JSON.stringify(counts).padEnd(7),
    verdict,
  );
}

console.log(
  mismatches === 0
    ? `\nOK: no topic-count mismatches. ${declared.length - unobserved}/${declared.length} declared` +
        ' events were observed with the declared indexed flags' +
        (unobserved === 0
          ? '.'
          : `; ${unobserved} carried no logs in the scanned range or the evidence transactions.`)
    : `\n${mismatches} topic-count MISMATCH(es) — fix the indexed flags in config.yaml before indexing.`,
);
process.exit(mismatches === 0 ? 0 : 1);
