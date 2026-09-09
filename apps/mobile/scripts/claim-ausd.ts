// Claim testnet AUSD from Agora's faucet into the treasury wallet.
//
//   TREASURY_PRIVATE_KEY=0x... node scripts/claim-ausd.ts [claims]
//
// Reads the key from the environment and never logs it — only the derived
// address. Put the key in .env (gitignored) rather than passing it inline, so
// it does not land in shell history.
//
// Why this exists: the faucet is finite (~74 claims when measured) and draining
// at ~8.6 claims/day, while the hackathon runs five more weeks. One claim is
// 10,000 AUSD and Perpl's testnet minimum is 100, so a single claim funds 100
// demo accounts. Bank two and stop. See docs/monad-testnet-assets.md, MOV-260.

import { createPublicClient, createWalletClient, http, formatUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const FAUCET = getAddress('0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C');
const AUSD = getAddress('0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC');

// Custom errors, decoded from live reverts — the contract has no verified source.
const COOLDOWN = '0x20e5bc67'; // global 60s window, shared with every other user
const CEILING = '0x0949dab9'; // recipient already holds >= 100,000 AUSD

const FAUCET_ABI = [
  {
    name: 'requestFunds',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [],
  },
] as const;
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const key = process.env['TREASURY_PRIVATE_KEY'];
if (!key) {
  console.error('set TREASURY_PRIVATE_KEY (put it in .env, which is gitignored)');
  process.exit(1);
}
const claims = Number(process.argv[2] ?? 2);

// Accept the key with or without the 0x prefix — viem requires it, and pasting
// a bare 64-char hex string is the obvious mistake to make.
const normalized = (key.startsWith('0x') ? key : `0x${key}`).trim() as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
  console.error(
    `TREASURY_PRIVATE_KEY is not a 32-byte hex key (got ${normalized.length - 2} hex chars)`,
  );
  process.exit(1);
}
const account = privateKeyToAccount(normalized);
const rpc = process.env['MONAD_TESTNET_RPC_URL'] ?? 'https://testnet-rpc.monad.xyz';
const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });

const ausd = () =>
  pub.readContract({
    address: AUSD,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`treasury:  ${account.address}`); // address only, never the key

const mon = await pub.getBalance({ address: account.address });
console.log(`mon:       ${formatUnits(mon, 18)} MON`);
if (mon === 0n) {
  // Without this the RPC returns "Missing or invalid parameters", which tells
  // you nothing about the actual problem.
  console.error(`\nNo MON for gas. Fund ${account.address} at https://faucet.monad.xyz first.`);
  process.exit(1);
}
console.log(`ausd:      ${formatUnits(await ausd(), 6)} AUSD`);
console.log(
  `faucet:    ${formatUnits(await pub.readContract({ address: AUSD, abi: ERC20_ABI, functionName: 'balanceOf', args: [FAUCET] }), 6)} AUSD remaining`,
);
console.log(`claiming:  ${claims}\n`);

for (let i = 1; i <= claims; i++) {
  for (let attempt = 1; ; attempt++) {
    try {
      // Explicit gas: Monad charges on gas_limit, not gas used, so an estimate
      // is money spent rather than reserved. ~130k observed.
      const hash = await wallet.writeContract({
        address: FAUCET,
        abi: FAUCET_ABI,
        functionName: 'requestFunds',
        args: [account.address],
        gas: 200_000n,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      console.log(`claim ${i}: ${receipt.status} ${hash}`);
      console.log(`         balance now ${formatUnits(await ausd(), 6)} AUSD`);
      break;
    } catch (err) {
      const msg = String(err);
      if (msg.includes(CEILING)) {
        console.log(`claim ${i}: refused — already holding >= 100,000 AUSD. Nothing to do.`);
        process.exit(0);
      }
      if (msg.includes(COOLDOWN)) {
        // Global cooldown: someone else claimed. Not our failure.
        if (attempt > 10) {
          console.error(`claim ${i}: still cooling down after 10 tries, giving up`);
          process.exit(1);
        }
        console.log(`claim ${i}: global 60s cooldown active (attempt ${attempt}) — waiting 20s`);
        await sleep(20_000);
        continue;
      }
      console.error(`claim ${i}: failed —`, msg.split('\n')[0]);
      process.exit(1);
    }
  }
  if (i < claims) {
    console.log('waiting 65s for the global cooldown...\n');
    await sleep(65_000);
  }
}
console.log('\ndone. Record the address and tx hashes on MOV-260.');
