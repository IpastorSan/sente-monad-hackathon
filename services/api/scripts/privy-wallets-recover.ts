// Find a user's Privy wallet again when the registry is gone (SEN-48).
//
//   pnpm --filter @sente/api run privy:recover
//   pnpm --filter @sente/api run privy:recover -- --device-key <base64 SPKI>
//   pnpm --filter @sente/api run privy:recover -- --user <userId> --device-key <b64> --apply
//
// ## The failure this answers
//
// A Privy wallet's address is not derivable from its owner key, so a lost
// `UserWalletRegistry` entry is not an inconvenience: the next
// `POST /wallet/register` mints a SECOND wallet, and whatever the first one
// holds stops being reachable from the product. `STATE_DIR` (SEN-48) stops that
// happening again. This script is for the registry that was already lost —
// before the state file existed, or because it was deleted.
//
// The wallet itself is never lost: Privy still has it, still owned by the same
// device key. What is lost is the mapping from our `userId` to its wallet id.
// So recovery is a search, and the device public key is the evidence: every
// user wallet is owned by a 1-key quorum holding exactly that key
// (`src/agents/privy/user-wallet.ts`).
//
// ## What answers, and what does not (measured live on 2026-09-18)
//
// `GET /v1/wallets` **works** and returns the app's wallets — unlike
// `GET /v1/key_quorums` and `GET /v1/policies`, which both answer 405 (which is
// why the probe scripts write their ids back into `.env`). Two caveats found by
// measuring rather than reading:
//
//   - **Unpaged is the reliable call.** With no `limit` it returned all 43
//     wallets in one page with `next_cursor: null`.
//   - **`limit` + `cursor` paging is not trustworthy**: with `limit=3`, page 2
//     repeated an entry from page 1 and later pages repeated each other, so a
//     naive loop both duplicates and skips. This script therefore asks unpaged,
//     and follows `next_cursor` only defensively — deduplicating by wallet id
//     and stopping as soon as a page adds nothing new.
//
// `GET /v1/key_quorums/{id}` **does** work (only the LIST is 405), and that is
// what turns an `owner_id` back into the device public key it holds.
//
// ## Read-only unless you say otherwise
//
// Nothing here creates, patches or deletes anything at Privy, in any mode.
// `--apply` writes one binding into the local state file and nothing else, and
// it needs `--user` and `--device-key` together: this script can prove which
// wallet a device key owns, but only the operator can say which of OUR users
// that device belongs to. The binding still goes through the registry's own
// `bind`, so an existing binding under a different device key is refused here
// exactly as it is in `POST /wallet/register`.
//
// SECRETS: the app secret is never printed. What is printed is wallet ids,
// addresses, quorum ids and PUBLIC keys.

import { existsSync } from 'node:fs';

import { getAddress } from 'viem';

import type { UserWallet } from '../src/agents/privy/user-wallet.ts';
import { PrivyClient, PrivyError } from '../src/agents/privy/privy.client.ts';
import type { KeyQuorum } from '../src/agents/privy/key-quorum.ts';
import { STATE_DIR_VAR, statePath } from '../src/state/json-file.ts';
import { FileUserWalletRegistry } from '../src/wallet/store/file-user-wallet-registry.ts';
import { envFileFromArgs } from './env-file.ts';

/**
 * A listed wallet: the shape `user-wallet.ts` models, plus the display name the
 * list endpoint returns — `sente-user-<last 6 of the userId>` for ours, which is
 * a hint for the operator and never an identity.
 */
type ListedWallet = UserWallet & { display_name?: string | null };

/** Privy's list envelope. `next_cursor` is the last id of the page, or null. */
interface WalletPage {
  data: ListedWallet[];
  next_cursor: string | null;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

/**
 * Every wallet in the app. Unpaged first (the call that is known to return
 * everything), then `next_cursor` defensively — see the header on why the
 * cursor cannot be trusted to walk forwards.
 */
async function listWallets(privy: PrivyClient): Promise<ListedWallet[]> {
  const byId = new Map<string, ListedWallet>();
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const query: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '';
    const answer: WalletPage = await privy.get<WalletPage>(`/v1/wallets${query}`);
    const before = byId.size;
    for (const wallet of answer.data) byId.set(wallet.id, wallet);
    const added = byId.size - before;
    if (!answer.next_cursor || answer.next_cursor === cursor || added === 0) break;
    cursor = answer.next_cursor;
  }
  return [...byId.values()];
}

/**
 * The user-wallet shape (`src/agents/privy/user-wallet.ts`): an owner quorum,
 * no policy, no signer. An AGENT wallet has both, so this is what separates the
 * two without a registry to ask. A heuristic, and named as one: a wallet some
 * other tool made bare would look the same, which is why the device key, not
 * this filter, is what decides.
 */
function looksLikeUserWallet(wallet: ListedWallet): boolean {
  return (
    wallet.owner_id !== null &&
    wallet.policy_ids.length === 0 &&
    (wallet.additional_signers ?? []).length === 0
  );
}

/**
 * A quorum with no authorization keys is not a failure: it can own its wallet
 * through `user_ids` instead — a Privy-user embedded wallet, never one of ours.
 * Ours always holds the device key, so it can never match one of those.
 */
function describeKeys(keys: readonly string[], quorumRead: boolean): string {
  if (keys.length > 0) return keys.join(' ');
  return quorumRead ? '(no keys — owned by a Privy user, not a device)' : '(quorum unreadable)';
}

async function main(): Promise<number> {
  const envFile = envFileFromArgs();
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const appId = process.env['PRIVY_APP_ID']?.trim();
  const appSecret = process.env['PRIVY_APP_SECRET']?.trim();
  if (!appId || !appSecret) {
    console.log('pending credentials: set PRIVY_APP_ID and PRIVY_APP_SECRET in', envFile);
    return 0;
  }

  const deviceKey = flag('device-key');
  const userId = flag('user');
  const apply = process.argv.includes('--apply');
  const stateDirArg = flag('state-dir');
  const registryPath = statePath(
    'user-wallets',
    stateDirArg ? { [STATE_DIR_VAR]: stateDirArg } : process.env,
  );

  if (apply && (!userId || !deviceKey)) {
    console.error('--apply needs both --user <userId> and --device-key <base64 SPKI>');
    return 1;
  }
  if (apply && !registryPath) {
    console.error(`--apply needs a state file: set ${STATE_DIR_VAR} or pass --state-dir <dir>`);
    return 1;
  }

  const privy = new PrivyClient({ appId, appSecret });
  const wallets = await listWallets(privy);
  const candidates = wallets.filter(looksLikeUserWallet);
  console.log(
    `${wallets.length} wallet(s) in app ${appId}; ${candidates.length} in the user-wallet shape ` +
      '(owner quorum, no policy, no signer)',
  );

  // One fetch per distinct quorum, not per wallet.
  const quorums = new Map<string, KeyQuorum>();
  for (const wallet of candidates) {
    const id = wallet.owner_id!;
    if (quorums.has(id)) continue;
    try {
      quorums.set(id, await privy.get<KeyQuorum>(`/v1/key_quorums/${id}`));
    } catch (error) {
      const detail = error instanceof PrivyError ? `${error.status}` : String(error);
      console.warn(`  ! quorum ${id} unreadable (${detail}); its wallets cannot be matched`);
    }
  }

  const keysOf = (wallet: ListedWallet): string[] =>
    (quorums.get(wallet.owner_id!)?.authorization_keys ?? []).map((key) => key.public_key);

  const matches = deviceKey
    ? candidates.filter((wallet) => keysOf(wallet).includes(deviceKey))
    : candidates;

  console.log('');
  for (const wallet of matches) {
    const keys = keysOf(wallet);
    console.log(
      [
        `wallet ${wallet.id}`,
        `address ${getAddress(wallet.address)}`,
        `quorum ${wallet.owner_id}`,
        `name ${wallet.display_name ?? '-'}`,
        // `sente-user-<last 6 of userId>` is what `UserWalletService` names
        // these. A hint for the operator, never an identity.
        `keys ${describeKeys(keys, quorums.has(wallet.owner_id!))}`,
      ].join('  '),
    );
  }
  if (matches.length === 0) {
    console.log(
      deviceKey
        ? 'No wallet is owned by a quorum holding that device key. Either it was never ' +
            'registered, or it belongs to another Privy app.'
        : 'No user-shaped wallets in this app.',
    );
    return deviceKey ? 1 : 0;
  }

  if (!deviceKey) {
    console.log('\nNarrow it with --device-key <base64 SPKI DER of the phone P-256 device key>.');
    return 0;
  }
  if (matches.length > 1) {
    console.error(
      `\n${matches.length} wallets share that device key — refusing to guess. This should not ` +
        'happen: one register per device key is exactly what the registry enforces. Pick the ' +
        'funded one by looking at balances before binding anything.',
    );
    return 1;
  }

  const wallet = matches[0]!;
  if (!apply) {
    console.log(
      `\nThat is the wallet. Re-bind it with:\n  ... --user <userId> --device-key <key> --apply` +
        `${stateDirArg ? ` --state-dir ${stateDirArg}` : ''}`,
    );
    return 0;
  }

  const registry = new FileUserWalletRegistry(registryPath!);
  const result = await registry.bind({
    userId: userId!,
    walletId: wallet.id,
    address: getAddress(wallet.address),
    ownerQuorumId: wallet.owner_id!,
    devicePublicKey: deviceKey,
  });
  if (!result.ok) {
    console.error(
      `\nRefused: user ${userId} is already bound to wallet ${result.existing.walletId} under a ` +
        'different device key. That refusal is the registry doing its job — resolve which wallet ' +
        'is the real one before editing the state file by hand.',
    );
    return 1;
  }
  console.log(
    `\n${result.created ? 'Bound' : 'Already bound'}: user ${userId} -> wallet ${wallet.id} ` +
      `(${getAddress(wallet.address)}) in ${registry.path}`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
