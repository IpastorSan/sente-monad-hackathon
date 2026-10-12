// Claim Set C test tokens from Kuru's TestnetTokenFaucet (SEN-189).
//
//   mise exec -- pnpm --filter @sente/venues run kuru:faucet -- [--key treasury|starter]
//                                                             [--dry-run] [--rpc <url>]
//
// One claim pays the CALLER 10,000 Set-C USDC, 1 WETH, 0.1 cbBTC and 1 XAUt,
// once per address every 12 h. It is how the treasury and the starter-kit
// sender hold the USDC Sente hands out while KURU_DEPLOYMENT=set-c; Set D's
// USDC has no faucet at all.
//
// The key is read from the repo's .env (`--key treasury` → TREASURY_PRIVATE_KEY,
// `--key starter` → STARTER_DRIP_PRIVATE_KEY) and never printed: only its
// address is. A claim costs ~0.03 MON (270,000 gas, charged at the limit on
// Monad, CLAUDE.md gotcha 4). With the cooldown still running it sends nothing
// and exits 0, saying when the next claim opens; `--dry-run` never sends.
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { KURU_DEPLOYMENT, KURU_DEPLOYMENTS, KURU_FAUCET } from '../src/kuru/constants.ts';
import {
  KURU_FAUCET_NEXT_CLAIM_ABI,
  kuruFaucetClaimCall,
  kuruFaucetWaitSeconds,
  parseKuruFaucetArgs,
} from '../src/kuru/faucet.ts';

const args = parseKuruFaucetArgs(process.argv.slice(2));
const raw = process.env[args.envVar]?.trim();
if (!raw) {
  console.error(`set ${args.envVar} in the repo .env (the package script loads it)`);
  process.exit(2);
}
const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(`${args.envVar} is not a 32-byte hex key`);
  process.exit(2);
}

const account = privateKeyToAccount(key);
const transport = http(args.rpcUrl);
const pub = createPublicClient({ chain: monadTestnet, transport });
const wallet = createWalletClient({ account, chain: monadTestnet, transport });
const usdc = KURU_DEPLOYMENTS['set-c'].tokens.USDC;

async function usdcHeld(): Promise<string> {
  const atoms = await pub.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  return formatUnits(atoms, usdc.decimals);
}

async function main(): Promise<number> {
  console.log(`${args.key} key ${account.address} (${args.envVar})`);
  if (KURU_DEPLOYMENT.id !== 'set-c') {
    console.log(
      `note: KURU_DEPLOYMENT here is ${KURU_DEPLOYMENT.id}; this faucet pays Set C tokens, ` +
        'which Sente trades only with KURU_DEPLOYMENT=set-c',
    );
  }
  const [mon, before, next] = await Promise.all([
    pub.getBalance({ address: account.address }),
    usdcHeld(),
    pub.readContract({
      address: KURU_FAUCET.address,
      abi: KURU_FAUCET_NEXT_CLAIM_ABI,
      functionName: 'nextClaimAt',
      args: [account.address],
    }),
  ]);
  console.log(`  MON ${formatEther(mon)}, Set-C USDC ${before}`);

  const wait = kuruFaucetWaitSeconds(next, Date.now() / 1000);
  if (wait > 0) {
    const at = new Date(Number(next) * 1000).toISOString();
    console.log(`  cooldown: next claim at ${at} (in ${Math.ceil(wait / 60)} min); nothing sent`);
    return 0;
  }
  const claim = kuruFaucetClaimCall();
  if (args.dryRun) {
    console.log(`  dry run: would send claim() to ${claim.to} with gas ${claim.gas}`);
    return 0;
  }
  // A read first: a claim that would revert is refused here, not paid for.
  await pub.call({ account, to: claim.to, data: claim.data, gas: claim.gas });
  const hash = await wallet.sendTransaction({ to: claim.to, data: claim.data, gas: claim.gas });
  console.log(`  claim sent: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error(`  claim reverted in block ${receipt.blockNumber}`);
    return 1;
  }
  console.log(`  claimed in block ${receipt.blockNumber}; Set-C USDC now ${await usdcHeld()}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
