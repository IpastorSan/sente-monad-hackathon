import { DEFAULT_SESSION_TTL_S, loadAuthConfig, MAX_SESSION_TTL_S } from './auth.config';

const SECRET = `0x${'ab'.repeat(32)}`;

describe('loadAuthConfig', () => {
  it('reads a hex secret with or without the 0x prefix, and defaults the TTL', () => {
    const prefixed = loadAuthConfig({ AUTH_SESSION_SECRET: SECRET });
    const bare = loadAuthConfig({ AUTH_SESSION_SECRET: 'ab'.repeat(32) });

    expect(prefixed.sessionSecret.toString('hex')).toBe('ab'.repeat(32));
    expect(prefixed.sessionSecret.equals(bare.sessionSecret)).toBe(true);
    expect(prefixed.mode).toBe('session');
    expect(prefixed.ephemeralSecret).toBe(false);
    expect(prefixed.sessionTtlS).toBe(DEFAULT_SESSION_TTL_S);
  });

  it('refuses to boot without a secret, because there would be nothing to sign tokens with', () => {
    expect(() => loadAuthConfig({})).toThrow(/AUTH_SESSION_SECRET is required/);
  });

  it('refuses a secret that is not 32 bytes of hex', () => {
    for (const bad of ['0xdeadbeef', 'zz'.repeat(32), 'ab'.repeat(31)]) {
      expect(() => loadAuthConfig({ AUTH_SESSION_SECRET: bad })).toThrow(/32 bytes of hex/);
    }
  });

  it('refuses AUTH_PLACEHOLDER under NODE_ENV=production — a header is not auth', () => {
    expect(() =>
      loadAuthConfig({
        AUTH_PLACEHOLDER: '1',
        NODE_ENV: 'production',
        AUTH_SESSION_SECRET: SECRET,
      }),
    ).toThrow(/refused under NODE_ENV=production/);
    // …and it is the placeholder that is refused, not the deployment: the same
    // environment without it boots.
    expect(() =>
      loadAuthConfig({ NODE_ENV: 'production', AUTH_SESSION_SECRET: SECRET }),
    ).not.toThrow();
  });

  it('mints an ephemeral secret in placeholder mode, so the token flow still works locally', () => {
    const config = loadAuthConfig({ AUTH_PLACEHOLDER: '1' });

    expect(config.mode).toBe('placeholder');
    expect(config.ephemeralSecret).toBe(true);
    expect(config.sessionSecret).toHaveLength(32);
    // Two boots do not share it: tokens die with the process, which is exactly
    // what "no configured secret" should mean.
    expect(
      config.sessionSecret.equals(loadAuthConfig({ AUTH_PLACEHOLDER: '1' }).sessionSecret),
    ).toBe(false);
  });

  it('validates AUTH_SESSION_TTL_S', () => {
    expect(
      loadAuthConfig({ AUTH_SESSION_SECRET: SECRET, AUTH_SESSION_TTL_S: '3600' }).sessionTtlS,
    ).toBe(3600);
    for (const bad of ['0', '-1', '1.5', 'soon', String(MAX_SESSION_TTL_S + 1)]) {
      expect(() =>
        loadAuthConfig({ AUTH_SESSION_SECRET: SECRET, AUTH_SESSION_TTL_S: bad }),
      ).toThrow(/AUTH_SESSION_TTL_S/);
    }
  });
});
