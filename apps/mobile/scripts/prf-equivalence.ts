/**
 * Proof for SEN-176: asking for the `device` salt as `eval.second` in the same
 * ceremony as the `wallet` salt yields the SAME wallet address and the SAME
 * device public key as the two-ceremony sign-in every earlier build used.
 *
 * Runs a real WebAuthn stack: headless Google Chrome (or `CHROME_PATH`) with a
 * CDP virtual authenticator that has PRF (`hasPrf: true`), on a page whose
 * origin is really `https://sente.lol` (served by request interception, so no
 * DNS, certificate or server is involved). The app's own code runs here in
 * node — `src/auth/ceremony.ts`, `derive.ts`, `deviceKey.ts` and the patched
 * mera — with mera's *browser* client, whose `navigator.credentials` calls are
 * forwarded into the page and counted.
 *
 * With one credential it runs, in order:
 *
 *   1. NEW create            createKeyMaterial (both salts at creation)
 *   2. OLD sign-in           wallet assertion, then a pinned device assertion —
 *                            the pre-SEN-176 code path, reproduced verbatim
 *   3. NEW sign-in           assertKeyMaterial, discoverable
 *   4. NEW sign-in, pinned   assertKeyMaterial with the stored hint
 *   5. NEW, fallback         as 3, but the page drops `eval.second`, as a
 *                            provider without second-salt support would
 *
 * and then, with a second credential, an OLD create (wallet-only creation plus
 * a pinned device assertion) checked against a NEW sign-in.
 *
 * Exits non-zero unless every address, device SPKI and raw device PRF output
 * is byte-identical across paths. The output is recorded in `docs/web.md`.
 *
 *   mise exec -- pnpm --filter @sente/mobile run prf:equivalence
 */
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput } from '@category-labs/mera';
import { base64 } from '@scure/base';
import { chromium, type Page } from 'playwright-core';
import { privateKeyToAddress } from 'viem/accounts';
import { bytesToHex } from 'viem/utils';

import {
  assertKeyMaterial,
  createKeyMaterial,
  toCredentialMetadata,
  type SessionKeyMaterial,
  type StoredCredential,
} from '../src/auth/ceremony.ts';
import { RP_ID } from '../src/auth/constants.ts';
import { deriveDeviceKey, deriveEvmKey, prfSaltFor, zeroize } from '../src/auth/derive.ts';
import { devicePublicKeySpki } from '../src/auth/deviceKey.ts';

import { addPrfAuthenticator, CHROME } from './virtualAuthenticator.ts';

const RP = { id: RP_ID, name: 'Sente' };

type Outcome = {
  label: string;
  ceremonies: string[];
  credentialId: string;
  address: string;
  deviceSpki: string;
  devicePrf: string;
};

// ------------------------------------------------------------ browser bridge

/** JSON-safe: every byte array replaced by `{ __b64 }`. */
type Wire = unknown;

function toWire(value: unknown): Wire {
  if (value instanceof ArrayBuffer) return { __b64: base64.encode(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      __b64: base64.encode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toWire(v)]),
    );
  }
  return value;
}

type PageAnswer = {
  type: string;
  rawId: string;
  transports: string[] | null;
  prf: { enabled?: boolean; results?: { first?: string; second?: string } } | null;
};

/** Runs one `navigator.credentials.<op>` in the page; base64 in, base64 out. */
async function inPage(
  page: Page,
  op: 'create' | 'get',
  options: Wire,
  dropSecond: boolean,
): Promise<PageAnswer> {
  return page.evaluate(
    async ({ op, options, dropSecond }) => {
      const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const bytesToB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
      const revive = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(revive);
        if (v !== null && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (typeof o.__b64 === 'string') return b64ToBytes(o.__b64);
          return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
        }
        return v;
      };
      const revived = revive(options) as {
        publicKey: { extensions?: { prf?: { eval?: { second?: unknown } } } };
      };
      if (dropSecond) delete revived.publicKey.extensions?.prf?.eval?.second;
      const cred = (await navigator.credentials[op](
        revived as CredentialCreationOptions & CredentialRequestOptions,
      )) as PublicKeyCredential;
      const ext = cred.getClientExtensionResults() as {
        prf?: { enabled?: boolean; results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
      };
      const response = cred.response as AuthenticatorAttestationResponse;
      return {
        type: cred.type,
        rawId: bytesToB64(cred.rawId),
        transports: typeof response.getTransports === 'function' ? response.getTransports() : null,
        prf: ext.prf
          ? {
              ...(ext.prf.enabled !== undefined ? { enabled: ext.prf.enabled } : {}),
              ...(ext.prf.results
                ? {
                    results: {
                      ...(ext.prf.results.first
                        ? { first: bytesToB64(ext.prf.results.first) }
                        : {}),
                      ...(ext.prf.results.second
                        ? { second: bytesToB64(ext.prf.results.second) }
                        : {}),
                    },
                  }
                : {}),
            }
          : null,
      };
    },
    { op, options, dropSecond },
  );
}

/**
 * Installs a `navigator.credentials` in node that mera's browser client will
 * call, forwarding each ceremony into the page and logging it.
 */
function bridge(page: Page) {
  const log: string[] = [];
  let dropSecond = false;
  const call = async (op: 'create' | 'get', options: unknown) => {
    const wire = toWire(options) as { publicKey: { allowCredentials?: unknown[] } };
    const pinned = op === 'get' && (wire.publicKey.allowCredentials?.length ?? 0) > 0;
    const evalKeys = Object.keys(
      (options as { publicKey: { extensions: { prf: { eval: object } } } }).publicKey.extensions.prf
        .eval,
    );
    const a = await inPage(page, op, wire, dropSecond);
    log.push(
      `${op}${op === 'get' ? (pinned ? ' (pinned)' : ' (discoverable)') : ''} ` +
        `eval=[${evalKeys.filter((k) => !(dropSecond && k === 'second')).join(',')}] ` +
        `results=[${Object.keys(a.prf?.results ?? {}).join(',')}]`,
    );
    const ab = (s: string) => {
      const bytes = base64.decode(s);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    };
    const results = a.prf?.results;
    const prf = a.prf
      ? {
          ...(a.prf.enabled !== undefined ? { enabled: a.prf.enabled } : {}),
          ...(results
            ? {
                results: {
                  ...(results.first ? { first: ab(results.first) } : {}),
                  ...(results.second ? { second: ab(results.second) } : {}),
                },
              }
            : {}),
        }
      : undefined;
    return {
      type: a.type,
      rawId: ab(a.rawId),
      response: { ...(a.transports ? { getTransports: () => a.transports } : {}) },
      getClientExtensionResults: () => (prf ? { prf } : {}),
    };
  };
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: {
      create: (options: unknown) => call('create', options),
      get: (options: unknown) => call('get', options),
    },
  });
  return {
    take(): string[] {
      return log.splice(0);
    },
    set dropSecond(value: boolean) {
      dropSecond = value;
    },
  };
}

// ------------------------------------------------------------ the two paths

/** Pre-SEN-176 `signIn`, verbatim in what it asks the authenticator for. */
async function oldSignIn(credential?: StoredCredential): Promise<SessionKeyMaterial> {
  const wallet = await getPasskeyPrfOutput({
    rpId: RP_ID,
    ...(credential !== undefined ? { credential: toCredentialMetadata(credential) } : {}),
    prfSalt: prfSaltFor('wallet'),
  });
  const privateKey = deriveEvmKey(wallet.prfOutput, 0);
  zeroize(wallet.prfOutput);
  const device = await getPasskeyPrfOutput({
    rpId: RP_ID,
    credential: { credentialId: wallet.credentialId },
    prfSalt: prfSaltFor('device'),
  });
  if (device.credentialId !== wallet.credentialId) throw new Error('device answered another key');
  return {
    credential: { credentialId: wallet.credentialId },
    accountIndex: 0,
    privateKey,
    devicePrfOutput: device.prfOutput,
  };
}

/** Pre-SEN-176 `createWallet`: wallet-only creation, then the pinned device assertion. */
async function oldCreate(): Promise<SessionKeyMaterial> {
  const created = await createPasskeyWithPrfOutput({
    rp: RP,
    user: { name: 'old-path', displayName: 'old-path' },
    prfSalt: prfSaltFor('wallet'),
  });
  const privateKey = deriveEvmKey(created.prfOutput, 0);
  zeroize(created.prfOutput);
  const device = await getPasskeyPrfOutput({
    rpId: RP_ID,
    credential: { credentialId: created.credentialId },
    prfSalt: prfSaltFor('device'),
  });
  return {
    credential: { credentialId: created.credentialId },
    accountIndex: 0,
    privateKey,
    devicePrfOutput: device.prfOutput,
  };
}

function outcome(label: string, m: SessionKeyMaterial, ceremonies: string[]): Outcome {
  const deviceKey = deriveDeviceKey(m.devicePrfOutput);
  const result = {
    label,
    ceremonies,
    credentialId: m.credential.credentialId,
    address: privateKeyToAddress(bytesToHex(m.privateKey)),
    deviceSpki: devicePublicKeySpki(deviceKey),
    devicePrf: bytesToHex(m.devicePrfOutput),
  };
  zeroize(deviceKey, m.privateKey, m.devicePrfOutput);
  return result;
}

// ------------------------------------------------------------ run

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = false;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://sente.lol/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>prf</title>' }),
  );
  await page.goto('https://sente.lol/');
  const cdp = await context.newCDPSession(page);
  const authenticatorId = await addPrfAuthenticator(cdp);
  const version = await browser.version();
  console.log(`browser: ${CHROME} (${version}), origin ${await page.evaluate(() => origin)}`);
  console.log(`virtual authenticator ${authenticatorId}: ctap2.1, internal, uv, hasPrf=true\n`);

  const nav = bridge(page);
  const runs: Outcome[] = [];
  const run = async (label: string, go: () => Promise<SessionKeyMaterial>) => {
    const material = await go();
    runs.push(outcome(label, material, nav.take()));
  };

  await run('1 NEW create', () =>
    createKeyMaterial({
      rp: RP,
      user: { name: 'new-path', displayName: 'new-path' },
      accountIndex: 0,
      webAuthnClient: undefined,
    }),
  );
  const hint = { credentialId: runs[0]!.credentialId };
  await run('2 OLD sign-in', () => oldSignIn());
  await run('3 NEW sign-in', () =>
    assertKeyMaterial({ accountIndex: 0, webAuthnClient: undefined }),
  );
  await run('4 NEW sign-in, pinned', () =>
    assertKeyMaterial({ credential: hint, accountIndex: 0, webAuthnClient: undefined }),
  );
  nav.dropSecond = true;
  await run('5 NEW, provider drops second', () =>
    assertKeyMaterial({ credential: hint, accountIndex: 0, webAuthnClient: undefined }),
  );
  nav.dropSecond = false;

  // A second credential, made the old way, read the new way.
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await run('6 OLD create (2nd credential)', () => oldCreate());
  await run('7 NEW sign-in (2nd credential)', () =>
    assertKeyMaterial({ accountIndex: 0, webAuthnClient: undefined }),
  );

  for (const r of runs) {
    console.log(`${r.label}`);
    for (const c of r.ceremonies) console.log(`    ${c}`);
    console.log(`    ceremonies   ${r.ceremonies.length}`);
    console.log(`    credential   ${r.credentialId}`);
    console.log(`    address      ${r.address}`);
    console.log(`    device SPKI  ${r.deviceSpki}`);
    console.log(`    device PRF   ${r.devicePrf.slice(0, 18)}… (first 8 bytes)`);
  }

  const check = (what: string, group: Outcome[]) => {
    const [first, ...rest] = group;
    for (const field of ['credentialId', 'address', 'deviceSpki', 'devicePrf'] as const) {
      const same = rest.every((r) => r[field] === first![field]);
      if (!same) failed = true;
      console.log(`${same ? 'SAME' : 'DIFFERENT'}  ${field.padEnd(12)} ${what}`);
    }
  };
  console.log('');
  check('credential 1: runs 1-5', runs.slice(0, 5));
  check('credential 2: runs 6-7', runs.slice(5, 7));

  const counts = runs.map((r) => r.ceremonies.length).join(',');
  const expected = '1,2,1,1,2,2,1';
  if (counts !== expected) failed = true;
  console.log(`ceremony counts ${counts} (expected ${expected})`);
  if (runs[0]!.address === runs[5]!.address) {
    failed = true;
    console.log('DIFFERENT credentials derived the same address — the check is not discriminating');
  }
} finally {
  await browser.close();
}
console.log(failed ? '\nFAIL' : '\nPASS: one-ceremony and two-ceremony paths are byte-identical');
process.exit(failed ? 1 : 0);
