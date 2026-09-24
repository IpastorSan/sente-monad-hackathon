// The one step of infra/smoke.sh that curl cannot do: sign the challenge.
//
//   node infra/smoke-sign.mjs https://api.sente.lol
//
// Prints two lines to stdout and nothing else, so the caller can `eval` them:
//
//   SMOKE_ADDRESS=0x…
//   SMOKE_TOKEN=…
//
// THE KEY IS GENERATED HERE AND THROWN AWAY. It is a fresh random secp256k1 key
// whose address has never existed, which is exactly what makes this safe to run
// against production: the flow it exercises — POST /auth/challenge then
// POST /auth/session — is a proof of key possession and nothing else, so it
// creates no wallet, spends nothing, and leaves behind one spent nonce.
//
// It deliberately does NOT reuse a funded key or an Anvil test vector. A real
// user's key has no business in a smoke test, and the Anvil keys are published
// (../CLAUDE.md gotcha 11) — a token minted for one of those addresses would be
// a token anyone could mint.
//
// Run it from a checkout: it imports `viem` from the repo's own node_modules,
// resolved from this file's directory upwards, so `mise exec -- node` from
// anywhere works and no global install is needed.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const base = (process.argv[2] ?? 'https://api.sente.lol').replace(/\/+$/, '');

function fail(message) {
  console.error(`smoke-sign: ${message}`);
  process.exit(1);
}

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) fail(`POST ${path} -> HTTP ${response.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return fail(`POST ${path} -> not JSON: ${text.slice(0, 200)}`);
  }
}

const account = privateKeyToAccount(generatePrivateKey());

const challenge = await post('/auth/challenge', { address: account.address });
if (typeof challenge.message !== 'string' || !challenge.message) {
  fail(`/auth/challenge returned no message: ${JSON.stringify(challenge)}`);
}
// The server chose this string; we sign it verbatim. Signing anything of our own
// choosing would be the exact hole the nonce exists to close, so if this ever
// needs editing, something has gone wrong on the server.
const signature = await account.signMessage({ message: challenge.message });

const session = await post('/auth/session', { address: account.address, signature });
if (typeof session.token !== 'string' || !session.token) {
  fail(`/auth/session returned no token: ${JSON.stringify(session)}`);
}

console.log(`SMOKE_ADDRESS=${account.address}`);
console.log(`SMOKE_TOKEN=${session.token}`);
