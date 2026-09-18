import { mintSessionToken, verifySessionToken } from './session-token';

const SECRET = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const SUB = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const NOW = 1_800_000_000;

describe('session tokens', () => {
  it('round-trips the claims it was minted with', () => {
    const token = mintSessionToken(SECRET, { sub: SUB, exp: NOW + 60 });

    expect(verifySessionToken(SECRET, token, NOW)).toEqual({
      ok: true,
      claims: { sub: SUB, exp: NOW + 60 },
    });
  });

  it('cannot be forged without the secret', () => {
    const token = mintSessionToken(OTHER, { sub: SUB, exp: NOW + 60 });

    expect(verifySessionToken(SECRET, token, NOW)).toEqual({ ok: false, failure: 'bad_signature' });
  });

  it('refuses a token whose claims were edited under a valid-looking MAC', () => {
    const token = mintSessionToken(SECRET, { sub: SUB, exp: NOW + 60 });
    const [version, , mac] = token.split('.') as [string, string, string];
    // The attack this format exists to refuse: keep the MAC, swap the subject.
    const forged = Buffer.from(JSON.stringify({ sub: '0xdead', exp: NOW + 60 }), 'utf8').toString(
      'base64url',
    );

    expect(verifySessionToken(SECRET, `${version}.${forged}.${mac}`, NOW)).toEqual({
      ok: false,
      failure: 'bad_signature',
    });
  });

  it('refuses an expired token, at the expiry second', () => {
    const token = mintSessionToken(SECRET, { sub: SUB, exp: NOW });

    expect(verifySessionToken(SECRET, token, NOW)).toEqual({ ok: false, failure: 'expired' });
    expect(verifySessionToken(SECRET, token, NOW - 1)).toMatchObject({ ok: true });
  });

  it('refuses anything that is not one of our tokens', () => {
    const token = mintSessionToken(SECRET, { sub: SUB, exp: NOW + 60 });
    const [, payload, mac] = token.split('.') as [string, string, string];

    for (const bad of [
      '',
      'nonsense',
      `${payload}.${mac}`,
      // A JWT-shaped token with its own alg header: there is no `alg` to
      // negotiate here, so it is simply not ours.
      `eyJhbGciOiJub25lIn0.${payload}.${mac}`,
      `v2.${payload}.${mac}`,
    ]) {
      expect(verifySessionToken(SECRET, bad, NOW).ok).toBe(false);
    }
  });
});
