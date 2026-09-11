// DEV ONLY (SEN-6): fund an agent EOA from the treasury, for live checks.
//
//   pnpm --filter @sente/api run agent:fund -- --to 0x… [--mon 0.2] [--ausd 100] [--usdc 15]
//        [--dry-run] [--env-file <path>]
//
// Sends only what is asked for, and refuses anything above small caps
// (MON 0.25, AUSD 150, USDC 100). In production an agent's collateral comes
// from its user, and its gas from the gas drip; this is a testnet shortcut.
//
// The treasury key is TREASURY_PRIVATE_KEY in the repo-root .env. It is never
// printed: only the address it derives is. USDC is Kuru's testnet USDC; when
// the treasury holds too little, it claims from TestnetTokenFaucet first
// (10,000 USDC, 12 h cooldown per address). AUSD is transferred, never taken
// from the shared AUSD faucet.
//
// Gas limits are fixed (Monad charges the LIMIT, CLAUDE.md gotcha 4), and each
// ERC-20 call is estimated first as a READ: if the node says it needs more than
// the fixed limit, nothing is sent.

import { existsSync } from 'node:fs';

import { KURU_FAUCET, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { envFileFromArgs } from './env-file.ts';

const CAPS = { mon: '0.25', ausd: '150', usdc: '100' } as const;
/** docs/monad-testnet-assets.md: MON → EOA 21,000; ERC-20 transfer to a zero-balance holder 72,918. */
const GAS = { native: 21_000n, erc20Transfer: 82_000n } as const;
/** Published keys (CLAUDE.md gotcha 11): never fund what they control. */
const PUBLIC_KEY_ADDRESSES = new Set(
  [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    '0xEC4b217240f0292c65Bf136b341e400e2D28cA6F',
  ].map((a) => a.toLowerCase()),
);

const AUSD = {
  address: getAddress(PERPL_TESTNET_CONTRACTS.collateral),
  decimals: PERPL_COLLATERAL_DECIMALS,
};
const USDC = {
  address: getAddress(KURU_TESTNET_TOKENS.USDC.address),
  decimals: KURU_TESTNET_TOKENS.USDC.decimals,
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function amount(name: 'mon' | 'ausd' | 'usdc', decimals: number): bigint {
  const raw = arg(name);
  if (raw === undefined) return 0n;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`--${name} must be a positive decimal`);
  const value = parseUnits(raw, decimals);
  if (value > parseUnits(CAPS[name], decimals)) {
    throw new Error(`--${name} ${raw} is above the dev cap of ${CAPS[name]}; refusing`);
  }
  return value;
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // Stored with or without the 0x prefix; normalised here, never echoed.
  const raw = process.env['TREASURY_PRIVATE_KEY']?.trim().replace(/^0x/i, '');
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.error('TREASURY_PRIVATE_KEY is missing or malformed in the env file (value not shown)');
    return 1;
  }
  const key = `0x${raw}`;
  const to = arg('to');
  if (!to || !isAddress(to)) {
    console.error('--to <address> is required');
    return 1;
  }
  const recipient = getAddress(to);
  if (PUBLIC_KEY_ADDRESSES.has(recipient.toLowerCase())) {
    console.error(`${recipient} is controlled by a published key (CLAUDE.md gotcha 11); refusing`);
    return 1;
  }
  const mon = amount('mon', 18);
  const ausd = amount('ausd', AUSD.decimals);
  const usdc = amount('usdc', USDC.decimals);
  const dryRun = process.argv.includes('--dry-run');
  if (mon + ausd + usdc === 0n) {
    console.error('nothing to send: pass --mon, --ausd and/or --usdc');
    return 1;
  }

  const treasury = privateKeyToAccount(key as Hex);
  const rpc = process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
  const wallet = createWalletClient({
    account: treasury,
    chain: monadTestnet,
    transport: http(rpc),
  });

  if ((await pub.getCode({ address: recipient })) && mon > 0n) {
    console.error(`${recipient} has code; the 21k native-transfer limit would revert. Refusing.`);
    return 1;
  }

  const balanceOf = (token: Address, owner: Address) =>
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const report = async (label: string) => {
    for (const [who, address] of [
      ['treasury', treasury.address],
      ['recipient', recipient],
    ] as const) {
      const [m, a, u] = await Promise.all([
        pub.getBalance({ address }),
        balanceOf(AUSD.address, address),
        balanceOf(USDC.address, address),
      ]);
      console.log(
        `${label.padEnd(7)} ${who.padEnd(9)} ${address}  MON ${formatEther(m)}  ` +
          `AUSD ${formatUnits(a, AUSD.decimals)}  USDC ${formatUnits(u, USDC.decimals)}`,
      );
    }
  };

  await report('before');
  console.log(
    `plan    MON ${formatEther(mon)}  AUSD ${formatUnits(ausd, AUSD.decimals)}  ` +
      `USDC ${formatUnits(usdc, USDC.decimals)}${dryRun ? '  (dry run: nothing sent)' : ''}`,
  );
  if (dryRun) return 0;

  let gasSpent = 0n;
  const send = async (
    label: string,
    tx: { to: Address; data?: Hex; value?: bigint },
    gas: bigint,
  ) => {
    if (tx.data) {
      const estimate = await pub.estimateGas({ account: treasury.address, ...tx });
      if (estimate > gas)
        throw new Error(`${label}: node estimates ${estimate} gas, over the fixed ${gas}`);
    }
    const hash = await wallet.sendTransaction({ ...tx, gas });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(`tx      ${label.padEnd(14)} ${receipt.status}  gas ${gas}  ${hash}`);
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    return hash;
  };
  const transfer = (value: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, value] });

  // Native MON goes FIRST. Monad's reserve balance (10 MON by default) stops a
  // value transfer from taking an EOA below the reserve unless it is an
  // "emptying" transaction, which needs the sender to have sent nothing in the
  // last few blocks. With the treasury under 10 MON, a MON send right after
  // the faucet claim reverted with `reserve balance violation` (2026-09-11,
  // 0x5aa46174…1d6c); sent first, the same transfer landed. Gas-only ERC-20
  // calls are unaffected.
  if (mon > 0n) await send('MON', { to: recipient, value: mon }, GAS.native);

  if (usdc > 0n && (await balanceOf(USDC.address, treasury.address)) < usdc) {
    const next = await pub.readContract({
      address: KURU_FAUCET.address,
      abi: [
        {
          type: 'function',
          name: 'nextClaimAt',
          stateMutability: 'view',
          inputs: [{ type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ],
      functionName: 'nextClaimAt',
      args: [treasury.address],
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (next > now)
      throw new Error(`treasury is short of USDC and its faucet cooldown ends in ${next - now}s`);
    await send(
      'faucet claim',
      { to: KURU_FAUCET.address, data: KURU_FAUCET.claimSelector },
      KURU_FAUCET.claimGas,
    );
  }
  if (ausd > 0n) await send('AUSD', { to: AUSD.address, data: transfer(ausd) }, GAS.erc20Transfer);
  if (usdc > 0n) await send('USDC', { to: USDC.address, data: transfer(usdc) }, GAS.erc20Transfer);

  await report('after');
  console.log(
    `treasury MON spent on gas: ${formatEther(gasSpent)} (plus ${formatEther(mon)} sent)`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
