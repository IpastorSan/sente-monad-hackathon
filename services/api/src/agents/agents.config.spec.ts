import { loadAgentsConfig } from './agents.config';
import { generateAuthorizationKey } from './privy/authorization-key';

const agent = generateAuthorizationKey();
const owner = generateAuthorizationKey();

const FULL = {
  PRIVY_APP_ID: 'app-123',
  PRIVY_APP_SECRET: 'secret-FAKE-do-not-leak',
  PRIVY_AGENT_AUTH_KEY: agent.privateKey,
  PRIVY_MANDATE_OWNER_KEY: owner.privateKey,
};

/** Every secret a config error could conceivably leak. */
const SECRETS = [FULL.PRIVY_APP_SECRET, agent.privateKey, owner.privateKey];

function errorOf(env: NodeJS.ProcessEnv): string {
  try {
    loadAgentsConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadAgentsConfig to throw');
}

describe('loadAgentsConfig', () => {
  it('is unconfigured, not broken, when no Privy variable is set', () => {
    expect(loadAgentsConfig({}).privy).toBeUndefined();
  });

  it('loads both keys, deriving their public halves', () => {
    const { privy } = loadAgentsConfig(FULL);
    expect(privy?.appId).toBe('app-123');
    expect(privy?.agentAuthKey).toEqual(agent);
    expect(privy?.mandateOwnerKey).toEqual(owner);
    expect(privy?.agentQuorumId).toBeUndefined();
  });

  it("accepts Privy's wallet-auth: dashboard export and pinned quorum ids", () => {
    const { privy } = loadAgentsConfig({
      ...FULL,
      PRIVY_AGENT_AUTH_KEY: `wallet-auth:${agent.privateKey}`,
      PRIVY_AGENT_QUORUM_ID: 'kq-agent',
      PRIVY_MANDATE_QUORUM_ID: 'kq-owner',
    });
    expect(privy?.agentAuthKey.publicKey).toBe(agent.publicKey);
    expect(privy?.agentQuorumId).toBe('kq-agent');
    expect(privy?.mandateQuorumId).toBe('kq-owner');
  });

  it('refuses a half-configured env, naming what is missing and no values', () => {
    const message = errorOf({
      PRIVY_APP_ID: FULL.PRIVY_APP_ID,
      PRIVY_APP_SECRET: FULL.PRIVY_APP_SECRET,
    });
    expect(message).toMatch(/PRIVY_AGENT_AUTH_KEY, PRIVY_MANDATE_OWNER_KEY/);
    expect(message).toMatch(/privy:keys/);
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it('refuses a malformed key without echoing it', () => {
    const garbage = 'MIGHAgEAMBMGByqGSM49-not-a-key-LEAKED';
    const message = errorOf({ ...FULL, PRIVY_MANDATE_OWNER_KEY: garbage });
    expect(message).toMatch(/^PRIVY_MANDATE_OWNER_KEY is not a valid P-256 authorization key/);
    expect(message).not.toContain(garbage);
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it('refuses one key in both roles: the key that spends must not own its limit', () => {
    const message = errorOf({ ...FULL, PRIVY_MANDATE_OWNER_KEY: agent.privateKey });
    expect(message).toMatch(/must be different keys/);
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  describe('AGENT_MANDATE_OWNER (SEN-43)', () => {
    it('defaults to device, configured or not: the safe mode is the invisible one', () => {
      expect(loadAgentsConfig({}).mandateOwner).toBe('device');
      expect(loadAgentsConfig(FULL).mandateOwner).toBe('device');
      expect(loadAgentsConfig({ ...FULL, AGENT_MANDATE_OWNER: '  ' }).mandateOwner).toBe('device');
    });

    it('accepts server, the dev/demo mode', () => {
      expect(loadAgentsConfig({ ...FULL, AGENT_MANDATE_OWNER: 'server' }).mandateOwner).toBe(
        'server',
      );
    });

    it('refuses server in production: it would leave the mandate key on this server', () => {
      const message = errorOf({
        ...FULL,
        AGENT_MANDATE_OWNER: 'server',
        NODE_ENV: 'production',
      });
      expect(message).toMatch(/refused in production/);
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    });

    it('refuses an unknown mode rather than guessing which one was meant', () => {
      expect(errorOf({ ...FULL, AGENT_MANDATE_OWNER: 'phone' })).toMatch(
        /AGENT_MANDATE_OWNER must be one of device, server/,
      );
    });
  });
});
