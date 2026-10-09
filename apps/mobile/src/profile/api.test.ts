/**
 * `ProfileApi` against a recording `fetch` (SEN-172): the route, the bearer
 * token, the PATCH body, one re-authentication on a 401, the error body, and
 * a parse that never lets a malformed answer through.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProfile, ProfileApi, ProfileApiError } from './api.ts';

const BASE = 'http://api.test';

function recorder(...answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  }) as typeof fetch;
  let refreshes = 0;
  const api = new ProfileApi({
    auth: {
      token: () => 'old',
      refresh: () => {
        refreshes += 1;
        return Promise.resolve('new');
      },
    },
    baseUrl: `${BASE}/`,
    fetchImpl,
  });
  return { api, calls, refreshes: () => refreshes };
}

test('GET /profile with the session token', async () => {
  const { api, calls } = recorder({ status: 200, body: { name: 'Based Whale', avatarSeed: '2' } });
  assert.deepEqual(await api.get(), { name: 'Based Whale', avatarSeed: '2' });
  assert.equal(calls[0]!.url, `${BASE}/profile`);
  assert.equal(calls[0]!.init?.method, 'GET');
  assert.deepEqual(calls[0]!.init?.headers, { authorization: 'Bearer old' });
  assert.equal(calls[0]!.init?.body, undefined);
});

test('PATCH /profile sends exactly the patch, nulls included', async () => {
  const { api, calls } = recorder({ status: 200, body: { name: null, avatarSeed: '1' } });
  assert.deepEqual(await api.update({ name: null }), { name: null, avatarSeed: '1' });
  assert.equal(calls[0]!.init?.method, 'PATCH');
  assert.equal(calls[0]!.init?.body, '{"name":null}');
  assert.deepEqual(calls[0]!.init?.headers, {
    authorization: 'Bearer old',
    'content-type': 'application/json',
  });
});

test('a 401 signs in again once and retries with the new token', async () => {
  const { api, calls, refreshes } = recorder(
    { status: 401, body: { statusCode: 401, reason: 'session_expired', message: 'expired' } },
    { status: 200, body: { name: null, avatarSeed: null } },
  );
  assert.deepEqual(await api.get(), { name: null, avatarSeed: null });
  assert.equal(refreshes(), 1);
  assert.deepEqual(calls[1]!.init?.headers, { authorization: 'Bearer new' });
});

test('with no token yet it signs in first instead of collecting a 401', async () => {
  const calls: RequestInit[] = [];
  const api = new ProfileApi({
    auth: { token: () => null, refresh: () => Promise.resolve('fresh') },
    baseUrl: BASE,
    fetchImpl: ((_url: string, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response('{"name":null,"avatarSeed":null}', { status: 200 }));
    }) as typeof fetch,
  });
  await api.get();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.headers, { authorization: 'Bearer fresh' });
});

test('a refusal is a typed error carrying the reason and message', async () => {
  const { api } = recorder({
    status: 400,
    body: { statusCode: 400, reason: 'invalid_name', message: 'At least 2 characters.' },
  });
  const error = await api.update({ name: 'a' }).catch((e: unknown) => e);
  assert.ok(error instanceof ProfileApiError);
  assert.equal(error.status, 400);
  assert.equal(error.reason, 'invalid_name');
  assert.equal(error.message, 'At least 2 characters.');
});

test('the pipe’s message list is joined', async () => {
  const { api } = recorder({
    status: 400,
    body: { statusCode: 400, message: ['avatarSeed must be …', 'property bio should not exist'] },
  });
  const error = (await api.update({ avatarSeed: '1' }).catch((e: unknown) => e)) as Error;
  assert.equal(error.message, 'avatarSeed must be …; property bio should not exist');
});

test('parseProfile reads anything malformed as the default', () => {
  assert.deepEqual(parseProfile(undefined), { name: null, avatarSeed: null });
  assert.deepEqual(parseProfile('nope'), { name: null, avatarSeed: null });
  assert.deepEqual(parseProfile({ name: 7, avatarSeed: '../x' }), { name: null, avatarSeed: null });
  assert.deepEqual(parseProfile({ name: '   ', avatarSeed: '' }), { name: null, avatarSeed: null });
  assert.deepEqual(parseProfile({ name: 'Lunar Maxi', avatarSeed: 'r_2-x', extra: 1 }), {
    name: 'Lunar Maxi',
    avatarSeed: 'r_2-x',
  });
});
