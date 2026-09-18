import { UnauthorizedException } from '@nestjs/common';
import { privateKeyToAccount } from 'viem/accounts';

import { loadAuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import { InMemoryChallengeStore } from './challenge';
import { verifySessionToken } from './session-token';

/**
 * Anvil account #1 and #2. Their private keys are published (CLAUDE.md gotcha
 * 11) — which is the point: a test signer must never be an address anyone
 * would fund.
 */
const USER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const IMPOSTOR = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);

const SECRET = `0x${'ab'.repeat(32)}`;
const CONFIG = loadAuthConfig({ AUTH_SESSION_SECRET: SECRET, AUTH_SESSION_TTL_S: '3600' });

function setup() {
  const store = new InMemoryChallengeStore();
  return { store, auth: new AuthService(CONFIG, store) };
}

/** The whole client side of sign-in: ask, sign what came back, present it. */
async function signIn(service: AuthService, now = new Date()) {
  const challenge = await service.challenge(USER.address, now);
  const signature = await USER.signMessage({ message: challenge.message });
  return { challenge, signature };
}

describe('AuthService', () => {
  it('mints a token for a correctly signed challenge, subject = lowercase address', async () => {
    const { auth } = setup();
    const now = new Date('2026-09-18T10:00:00.000Z');

    const { challenge, signature } = await signIn(auth, now);
    const session = await auth.session(USER.address, signature, now);

    expect(challenge.message).toBe(
      `Sente sign-in\naddress: ${USER.address}\nnonce: ${challenge.nonce}\nissued: ${now.toISOString()}`,
    );
    expect(challenge.expiresAt).toBe(new Date(now.getTime() + 300_000).toISOString());
    expect(session.expiresAt).toBe(new Date(now.getTime() + 3_600_000).toISOString());

    const verified = verifySessionToken(
      CONFIG.sessionSecret,
      session.token,
      Math.floor(now.getTime() / 1000),
    );
    expect(verified).toEqual({
      ok: true,
      claims: { sub: USER.address.toLowerCase(), exp: Math.floor(now.getTime() / 1000) + 3600 },
    });
  });

  it('refuses a replayed challenge: a signature spends its nonce the first time it is seen', async () => {
    const { auth } = setup();
    const { signature } = await signIn(auth);

    await expect(auth.session(USER.address, signature)).resolves.toMatchObject({
      address: USER.address,
    });
    await expect(auth.session(USER.address, signature)).rejects.toMatchObject({
      response: { reason: 'challenge_not_found' },
    });
  });

  it('refuses an expired nonce', async () => {
    const { auth } = setup();
    const issued = new Date('2026-09-18T10:00:00.000Z');
    const { signature } = await signIn(auth, issued);

    const late = new Date(issued.getTime() + 300_001);
    await expect(auth.session(USER.address, signature, late)).rejects.toMatchObject({
      response: { reason: 'challenge_not_found' },
    });
  });

  it('refuses a signature by the wrong signer, and spends the nonce anyway', async () => {
    const { auth } = setup();
    const challenge = await auth.challenge(USER.address);
    const signature = await IMPOSTOR.signMessage({ message: challenge.message });

    await expect(auth.session(USER.address, signature)).rejects.toMatchObject({
      response: { reason: 'bad_signature' },
    });
    // The challenge is gone: a rejected attempt must not leave the nonce open
    // for a second guess.
    const correct = await USER.signMessage({ message: challenge.message });
    await expect(auth.session(USER.address, correct)).rejects.toMatchObject({
      response: { reason: 'challenge_not_found' },
    });
  });

  it('refuses a signature presented for another address', async () => {
    const { auth } = setup();
    const { signature } = await signIn(auth);

    await expect(auth.session(IMPOSTOR.address, signature)).rejects.toMatchObject({
      response: { reason: 'challenge_not_found' },
    });
  });

  it('refuses a caller that is not an address at all', async () => {
    const { auth } = setup();

    await expect(auth.challenge('alice')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('keeps only the newest challenge for an address', async () => {
    const { auth } = setup();
    const first = await auth.challenge(USER.address);
    await auth.challenge(USER.address);

    const stale = await USER.signMessage({ message: first.message });
    await expect(auth.session(USER.address, stale)).rejects.toMatchObject({
      response: { reason: 'bad_signature' },
    });
  });

  it('describes the mode without leaking the secret', () => {
    const { auth } = setup();

    expect(auth.describe()).toEqual({
      module: 'auth',
      mode: 'session',
      sessionTtlS: 3600,
      challengeTtlS: 300,
    });
  });
});
