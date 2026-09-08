/**
 * Sanity check for the shared viem client: reads the head block from Monad.
 *
 *   mise exec -- pnpm run read-block
 *
 * Node 26 strips the types natively, so no build step is needed.
 *
 * The npm script passes --no-warnings=MODULE_TYPELESS_PACKAGE_JSON: this package
 * is deliberately not `"type": "module"` (that would break Metro), so node probes
 * every .ts here as CommonJS first and warns when it has to reparse as ESM.
 */
import { MONAD_NETWORK, monadChain, publicClient } from '../src/chain/client.ts';

const blockNumber = await publicClient.getBlockNumber();

console.log(`network:      ${MONAD_NETWORK}`);
console.log(`chain:        ${monadChain.name} (${monadChain.id})`);
console.log(`rpc:          ${monadChain.rpcUrls.default.http[0]}`);
console.log(`blockNumber:  ${blockNumber}`);
