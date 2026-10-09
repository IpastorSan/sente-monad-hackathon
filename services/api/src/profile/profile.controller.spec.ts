/**
 * SEN-172 over HTTP: the real guard and the global ValidationPipe as main.ts
 * configures it, because 401s, the whitelist and `null` versus absent only
 * exist there.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { authConfig, resetAuthConfig } from '../auth/auth.config';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { mintSessionToken } from '../auth/session-token';
import { IpRateLimiter } from '../gas/rate-limit/ip-rate-limiter';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { ProfileStore } from './profile.store';

const SECRET = 'ef'.repeat(32);
const ORIGINAL = { ...process.env };
const ALICE = '0x' + 'a'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);

describe('ProfileController (SEN-172)', () => {
  let app: INestApplication;
  let base: string;
  let store: ProfileStore;
  let dir: string;

  async function boot(service: ProfileService): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        { provide: ProfileService, useValue: service },
        SessionAuthGuard,
        { provide: Auth, useClass: RequestContextAuth },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }

  beforeEach(async () => {
    process.env['AUTH_SESSION_SECRET'] = SECRET;
    delete process.env['AUTH_PLACEHOLDER'];
    resetAuthConfig();
    dir = mkdtempSync(join(tmpdir(), 'sente-profile-'));
    store = new ProfileStore(join(dir, 'profiles.json'));
    await boot(new ProfileService(store));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...ORIGINAL };
    resetAuthConfig();
  });

  function tokenFor(sub: string): string {
    return mintSessionToken(authConfig().sessionSecret, {
      sub,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  }

  async function call(
    method: 'GET' | 'PATCH',
    body?: unknown,
    who: string | null = ALICE,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who !== null) headers['authorization'] = `Bearer ${tokenFor(who)}`;
    const response = await fetch(new URL('/profile', base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('answers 401 without a session, on both routes', async () => {
    expect((await call('GET', undefined, null)).status).toBe(401);
    expect((await call('PATCH', { name: 'Based Whale' }, null)).status).toBe(401);
  });

  it('starts at the defaults: both null', async () => {
    expect(await call('GET')).toEqual({ status: 200, body: { name: null, avatarSeed: null } });
  });

  it('sets, keeps the field left out, and resets with null', async () => {
    expect((await call('PATCH', { name: '  Based   Whale ' })).body).toEqual({
      name: 'Based Whale',
      avatarSeed: null,
    });
    expect((await call('PATCH', { avatarSeed: '3' })).body).toEqual({
      name: 'Based Whale',
      avatarSeed: '3',
    });
    expect((await call('GET')).body).toEqual({ name: 'Based Whale', avatarSeed: '3' });
    expect((await call('PATCH', { name: null })).body).toEqual({ name: null, avatarSeed: '3' });
    expect((await call('PATCH', { avatarSeed: null })).body).toEqual({
      name: null,
      avatarSeed: null,
    });
    // Both back at the defaults: no record left behind.
    expect(store.size).toBe(0);
  });

  it('keeps each user to their own profile', async () => {
    await call('PATCH', { name: 'Rekt Otter' }, ALICE);
    expect((await call('GET', undefined, BOB)).body).toEqual({ name: null, avatarSeed: null });
    // The session's address, never a body field, names the user.
    expect((await call('PATCH', { userId: BOB, name: 'Evil' }, ALICE)).status).toBe(400);
    expect((await call('GET', undefined, BOB)).body).toEqual({ name: null, avatarSeed: null });
  });

  it.each([
    ['too short', { name: ' a ' }, 'invalid_name'],
    ['too long', { name: 'x'.repeat(25) }, 'invalid_name'],
    ['bad charset', { name: 'Based <Whale>' }, 'invalid_name'],
    ['leading punctuation', { name: '-Based' }, 'invalid_name'],
    ['zero-width character', { name: 'Based​Whale' }, 'invalid_name'],
    ['empty body', {}, 'empty_patch'],
  ])('refuses a %s with 400 %s', async (_label, body, reason) => {
    const response = await call('PATCH', body);
    expect(response.status).toBe(400);
    expect(response.body['reason']).toBe(reason);
  });

  it.each([
    ['a number name', { name: 7 }],
    ['an over-long raw name', { name: 'x'.repeat(65) }],
    ['a seed with a slash', { avatarSeed: '../x' }],
    ['an over-long seed', { avatarSeed: 'a'.repeat(33) }],
    ['an unknown field', { bio: 'gm' }],
  ])('refuses %s at the pipe', async (_label, body) => {
    expect((await call('PATCH', body)).status).toBe(400);
  });

  it('accepts names in other scripts and with inner punctuation', async () => {
    for (const name of ['Ñandú Veloz', "O'Brien 2", 'Ape_Lord.eth', '先手 Whale']) {
      expect((await call('PATCH', { name })).body['name']).toBe(name);
    }
  });

  it('writes through to profiles.json, and a new store reads it back', async () => {
    await call('PATCH', { name: 'Diamond Gecko', avatarSeed: 'r7' });
    const file = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')) as {
      records: { userId: string; name: string }[];
    };
    expect(file.records).toEqual([
      expect.objectContaining({ userId: ALICE, name: 'Diamond Gecko', avatarSeed: 'r7' }),
    ]);
    expect(new ProfileStore(join(dir, 'profiles.json')).get(ALICE)).toEqual({
      name: 'Diamond Gecko',
      avatarSeed: 'r7',
    });
  });

  it('answers 429 rate_limited past the write budget, per user', async () => {
    await app.close();
    await boot(new ProfileService(store, new IpRateLimiter(2, 60_000)));
    expect((await call('PATCH', { avatarSeed: '1' })).status).toBe(200);
    expect((await call('PATCH', { avatarSeed: '2' })).status).toBe(200);
    const third = await call('PATCH', { avatarSeed: '3' });
    expect(third.status).toBe(429);
    expect(third.body['reason']).toBe('rate_limited');
    // Reads are free, and another user has their own budget.
    expect((await call('GET')).body).toEqual({ name: null, avatarSeed: '2' });
    expect((await call('PATCH', { avatarSeed: '1' }, BOB)).status).toBe(200);
  });
});

describe('ProfileStore', () => {
  it('stays in memory without a path', () => {
    const store = new ProfileStore();
    store.set(ALICE, { name: 'Lucky Crab' }, new Date());
    expect(store.path).toBeUndefined();
    expect(store.get(ALICE)).toEqual({ name: 'Lucky Crab', avatarSeed: null });
  });
});
