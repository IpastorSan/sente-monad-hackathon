/**
 * The WebAuthn ceremonies behind sign-in, and the key material they yield.
 *
 * A session needs two PRF outputs from one passkey: one under the `wallet`
 * salt (the secp256k1 EOA) and one under the `device` salt (the P-256 key that
 * owns the Privy wallet). WebAuthn's PRF extension takes up to two salts per
 * ceremony (`eval: { first, second }`) and each output depends only on the
 * credential and its own salt, not on which slot it was asked for in. So both
 * are requested in the SAME ceremony, through the `prfSecondSalt` option our
 * mera patch adds (`patches/@category-labs__mera@0.2.0.patch`): one prompt.
 *
 * Not every provider evaluates `second`. When it comes back absent, the device
 * salt is asked for in a second assertion, pinned to the credential the first
 * one chose: the two-prompt path every build before SEN-176 always took, and
 * byte-for-byte the same output (`scripts/prf-equivalence.ts` proves that
 * against a real Chrome WebAuthn stack).
 *
 * The salts are `prfSaltFor('wallet')` and `prfSaltFor('device')`, and the
 * rpId is `RP_ID` — permanent inputs (CLAUDE.md). Nothing here changes them;
 * only how many ceremonies it takes to collect the outputs.
 *
 * Free of React Native: the WebAuthn client is injected, so specs drive this
 * with a fake and the equivalence script with mera's browser client.
 */
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
  type PasskeyCredentialTransport,
  type PasskeyRelyingParty,
  type WebAuthnClient,
} from '@category-labs/mera';

import { RP_ID } from './constants.ts';
import { deriveEvmKey, prfSaltFor, zeroize } from './derive.ts';

/** Stored hints for re-asserting a known credential. Not secrets. */
export type StoredCredential = {
  readonly credentialId: string;
  readonly transports?: readonly PasskeyCredentialTransport[];
};

/**
 * What a session is built from. The caller owns both byte arrays and must
 * zero them once the session holds its own copies.
 *
 * The wallet PRF output itself is never in here: it derives every BIP-44
 * index, so it is reduced to the one key this session uses and wiped before
 * anything else can happen (including a fallback prompt).
 */
export type SessionKeyMaterial = {
  readonly credential: StoredCredential;
  readonly accountIndex: number;
  /** secp256k1 private key for `accountIndex`, from the `wallet` PRF output. */
  readonly privateKey: Uint8Array;
  /** PRF output for the `device` salt. */
  readonly devicePrfOutput: Uint8Array;
};

type CommonOptions = {
  accountIndex: number;
  timeout?: number;
  /** `undefined` means mera's default, the browser client. */
  webAuthnClient: WebAuthnClient | undefined;
};

/** What every mera call here passes besides salts: set fields only. */
type Transport = { timeout?: number; webAuthnClient?: WebAuthnClient };

function transportOf({ timeout, webAuthnClient }: Omit<CommonOptions, 'accountIndex'>): Transport {
  return {
    ...(timeout !== undefined ? { timeout } : {}),
    ...(webAuthnClient !== undefined ? { webAuthnClient } : {}),
  };
}

export type AssertOptions = CommonOptions & {
  /** Optional hint; without it WebAuthn offers any discoverable credential. */
  credential?: StoredCredential;
};

export type CreateOptions = CommonOptions & {
  rp: PasskeyRelyingParty;
  user: { name: string; displayName: string };
};

/** Asserts an existing passkey for both salts, in one ceremony when possible. */
export async function assertKeyMaterial({
  credential,
  accountIndex,
  timeout,
  webAuthnClient,
}: AssertOptions): Promise<SessionKeyMaterial> {
  const transport = transportOf({ timeout, webAuthnClient });
  const asserted = await getPasskeyPrfOutput({
    rpId: RP_ID,
    ...(credential !== undefined ? { credential: toCredentialMetadata(credential) } : {}),
    prfSalt: prfSaltFor('wallet'),
    prfSecondSalt: prfSaltFor('device'),
    ...transport,
  });
  return finish({
    walletPrfOutput: asserted.prfOutput,
    devicePrfOutput: asserted.prfSecondOutput,
    // An assertion does not report transports, so keep the stored hint only
    // when the platform answered with the credential we asked for.
    credential: {
      credentialId: asserted.credentialId,
      ...(credential?.credentialId === asserted.credentialId && credential.transports !== undefined
        ? { transports: credential.transports }
        : {}),
    },
    accountIndex,
    transport,
  });
}

/**
 * Registers a passkey and collects both outputs.
 *
 * One prompt when the provider evaluates PRF at creation for both salts. Two
 * when it evaluates only at assertion time: mera's own fallback assertion then
 * asks for both salts. Two as well when it evaluates `first` but not `second`
 * at creation, since the device salt then needs its own assertion.
 */
export async function createKeyMaterial({
  rp,
  user,
  accountIndex,
  timeout,
  webAuthnClient,
}: CreateOptions): Promise<SessionKeyMaterial> {
  const transport = transportOf({ timeout, webAuthnClient });
  const created = await createPasskeyWithPrfOutput({
    rp,
    user,
    prfSalt: prfSaltFor('wallet'),
    prfSecondSalt: prfSaltFor('device'),
    ...transport,
  });
  return finish({
    walletPrfOutput: created.prfOutput,
    devicePrfOutput: created.prfSecondOutput,
    credential: { credentialId: created.credentialId, transports: created.transports },
    accountIndex,
    transport,
  });
}

/**
 * Reduces the wallet output to the session's key, wipes it, and fills in the
 * device output with a pinned assertion if the first ceremony did not return
 * one. Takes ownership of both outputs; wipes everything on a throw.
 */
async function finish({
  walletPrfOutput,
  devicePrfOutput,
  credential,
  accountIndex,
  transport,
}: {
  walletPrfOutput: Uint8Array;
  devicePrfOutput: Uint8Array | undefined;
  credential: StoredCredential;
  accountIndex: number;
  transport: Transport;
}): Promise<SessionKeyMaterial> {
  let privateKey: Uint8Array | undefined;
  let device = devicePrfOutput;
  try {
    privateKey = deriveEvmKey(walletPrfOutput, accountIndex);
    zeroize(walletPrfOutput);
    device ??= await assertDevicePrfOutput(credential, transport);
    const material = { credential, accountIndex, privateKey, devicePrfOutput: device };
    privateKey = undefined;
    device = undefined;
    return material;
  } finally {
    zeroize(walletPrfOutput, privateKey, device);
  }
}

/**
 * The second assertion, for the `device` salt alone: the fallback when the
 * provider did not evaluate `eval.second`.
 *
 * Restricted to the credential the wallet ceremony used, and refused if the
 * platform answers with another one: a device key from a different passkey
 * than the wallet would register an owner the user cannot reproduce.
 */
async function assertDevicePrfOutput(
  credential: StoredCredential,
  transport: Transport,
): Promise<Uint8Array> {
  const asserted = await getPasskeyPrfOutput({
    rpId: RP_ID,
    credential: toCredentialMetadata(credential),
    prfSalt: prfSaltFor('device'),
    ...transport,
  });
  if (asserted.credentialId !== credential.credentialId) {
    zeroize(asserted.prfOutput);
    throw new Error(
      'the device-key assertion answered with a different passkey than the wallet ceremony',
    );
  }
  return asserted.prfOutput;
}

export function toCredentialMetadata(credential: StoredCredential): PasskeyCredentialMetadata {
  return {
    credentialId: credential.credentialId,
    ...(credential.transports !== undefined ? { transports: credential.transports } : {}),
  };
}
