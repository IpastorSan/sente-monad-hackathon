// Generate Sente's two Privy authorization keys straight into `.env`.
//
//   pnpm --filter @sente/api run privy:keys [-- --env-file <path>] [-- --force]
//
//   PRIVY_AGENT_AUTH_KEY     owns the agent wallets; signs every trade request
//   PRIVY_MANDATE_OWNER_KEY  owns the policies; the only key that can change one
//
// Two keys, never one: the key that spends must never be able to raise its own
// limit (src/agents/agents.config.ts).
//
// NOTHING SECRET IS PRINTED. The private keys go into the file and nowhere
// else; stdout gets variable names and a fingerprint of each PUBLIC key, which
// is what Privy shows in a key quorum and is safe to paste anywhere.
//
// An existing non-empty value is kept. `--force` replaces it — and orphans
// every wallet or policy the old key owns, because Privy will only accept that
// key's signature for them. There is no recovering from that.

import { createHash } from 'node:crypto';

import {
  generateAuthorizationKey,
  loadAuthorizationKey,
} from '../src/agents/privy/authorization-key.ts';
import { envFileFromArgs, upsertEnv } from './env-file.ts';

const NAMES = ['PRIVY_AGENT_AUTH_KEY', 'PRIVY_MANDATE_OWNER_KEY'] as const;

function fingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

function main(): number {
  const envFile = envFileFromArgs();
  const force = process.argv.includes('--force');

  const generated = {
    PRIVY_AGENT_AUTH_KEY: generateAuthorizationKey(),
    PRIVY_MANDATE_OWNER_KEY: generateAuthorizationKey(),
  };
  const { written, kept } = upsertEnv(
    envFile,
    Object.fromEntries(NAMES.map((name) => [name, generated[name].privateKey])),
    { overwrite: force },
  );

  console.log(`env file: ${envFile}`);
  for (const name of written as (typeof NAMES)[number][]) {
    console.log(`wrote ${name}  (public key sha256 ${fingerprint(generated[name].publicKey)}…)`);
  }
  for (const name of kept) {
    console.log(`kept  ${name}  (already set; --force replaces it and orphans what it owns)`);
  }

  // Read back what the file now holds and prove the two roles are distinct
  // keys — without printing either.
  process.loadEnvFile(envFile);
  const [agent, owner] = NAMES.map((name) => loadAuthorizationKey(process.env[name] ?? ''));
  if (agent!.publicKey === owner!.publicKey) {
    console.error('PRIVY_AGENT_AUTH_KEY and PRIVY_MANDATE_OWNER_KEY are the same key — fix .env');
    return 1;
  }
  console.log('ok: two distinct P-256 keys; neither was printed');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  // loadAuthorizationKey's own errors never quote the key, but be certain.
  console.error(`privy-keys failed: ${(error as Error).name}`);
  process.exitCode = 1;
}
