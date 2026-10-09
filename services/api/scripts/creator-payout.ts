// What Sente owes the creators of forked agents, and recording a payout to one
// (SEN-184).
//
//   pnpm --filter @sente/api run creator:payout -- --state-dir <dir>
//   pnpm --filter @sente/api run creator:payout -- --state-dir <dir> \
//     --creator <userId> --asset USDC --amount 1.25 --tx 0x<treasury transfer> [--note "..."]
//
// The share accrues on its own: every Kuru fill of a forked agent that paid
// Sente's builder fee owes 3 of the 10 bps to the source agent's owner
// (`src/fees/creator-fees.ts`). Paying it is by hand and periodic: send the
// amount from the treasury to the creator's wallet, then run this with that
// transaction's hash so the ledger stops counting it as owed.
//
// Without `--creator` it only lists what each creator is owed. With it, it
// records ONE payout and refuses one larger than what is owed in that asset,
// or a tx hash already recorded. It sends nothing on chain.
//
// The API loads `creator-fees.json` once and rewrites it from memory, so a
// payout written while it runs would be overwritten by its next save. This
// takes the same STATE_DIR lock (SEN-161) and so refuses to run beside the
// API: stop it, record the payout, start it again.

import { fromUnits, KURU_TESTNET_TOKENS, toUnits } from '@sente/venues/kuru';

import { CREATOR_FEES_FILE, CreatorFeeLedger } from '../src/fees/creator-fees.ts';
import { STATE_DIR_VAR, stateDir, statePath } from '../src/state/json-file.ts';
import { acquireStateDirLock } from '../src/state/state-dir-lock.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function main(): number {
  const stateDirArg = flag('state-dir');
  const env = stateDirArg ? { [STATE_DIR_VAR]: stateDirArg } : process.env;
  const dir = stateDir(env);
  const path = statePath(CREATOR_FEES_FILE, env);
  if (!dir || !path) {
    console.error(`no state directory: set ${STATE_DIR_VAR} or pass --state-dir <dir>`);
    return 1;
  }
  acquireStateDirLock(dir);
  const ledger = new CreatorFeeLedger(path);

  const creator = flag('creator');
  if (!creator) {
    const creators = ledger.creators();
    if (creators.length === 0) console.log('nothing accrued yet');
    for (const userId of creators) {
      for (const t of ledger.totals(userId)) {
        console.log(
          `${userId}  ${t.asset}  owed ${fromUnits(t.owedAtoms, t.decimals)}  ` +
            `(accrued ${fromUnits(t.accruedAtoms, t.decimals)}, paid ${fromUnits(t.paidAtoms, t.decimals)})`,
        );
      }
    }
    return 0;
  }

  const asset = flag('asset');
  const amount = flag('amount');
  const tx = flag('tx');
  const note = flag('note');
  const token = Object.values(KURU_TESTNET_TOKENS).find((t) => t.symbol === asset);
  if (!token || !amount || !tx) {
    console.error('a payout needs --asset <Kuru symbol, e.g. USDC> --amount <decimal> --tx <hash>');
    return 1;
  }
  const payout = ledger.payout({
    creatorUserId: creator,
    asset: token.symbol,
    decimals: token.decimals,
    amountAtoms: toUnits(amount, token.decimals, 'amount'),
    txHash: tx,
    ...(note ? { note } : {}),
  });
  const owed = ledger.totals(creator).find((t) => t.asset === token.symbol)!;
  console.log(
    `recorded payout ${payout.id}: ${amount} ${token.symbol} to ${creator} in ${tx}; ` +
      `still owed ${fromUnits(owed.owedAtoms, owed.decimals)} ${token.symbol}`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
