/**
 * End-to-end check for SEN-176 on the web export: one passkey prompt to sign
 * in, none after a reload, and back to /welcome after signing out.
 *
 * Serves `dist-web` at a real `https://sente.lol` origin through request
 * interception, in headless Google Chrome (or `CHROME_PATH`) with a CDP
 * virtual authenticator that has PRF. The API is a stub on the export's
 * `API_URL` (default `http://localhost:3000`, or `API_URL`): `/auth/challenge`
 * and `/auth/session` answer, everything else is a 503, which the app shows as
 * an unreachable API and which has no bearing on being signed in. Every other
 * request (the Monad RPC, for one) is aborted and listed, so nothing this
 * harness does reaches a real API or chain; one aimed at a Sente host fails
 * the run, because it means the bundle is not using the stub.
 *
 * Build the export with `--clear` (or `EXPO_PUBLIC_API_URL` unset): Metro's
 * transform cache is shared between checkouts and can inline the API URL of
 * an earlier build, which is how a run once reached `https://api.sente.lol`.
 *
 *   mise exec -- pnpm exec expo export --platform web --output-dir dist-web --clear
 *
 * Counts `navigator.credentials` calls in the page and `/auth/session` calls on
 * the stub, and exits non-zero unless: create = 1 ceremony, reload = 0
 * ceremonies and still signed in on the same address, sign out + reload =
 * /welcome with nothing left in sessionStorage.
 *
 *   mise exec -- pnpm --filter @sente/mobile run e2e:web-reload
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { chromium, type Page } from 'playwright-core';

import { addPrfAuthenticator, CHROME } from './virtualAuthenticator.ts';

const DIST = join(import.meta.dirname, '..', 'dist-web');
const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

async function file(pathname: string): Promise<string> {
  const candidates = [pathname, `${pathname}.html`, join(pathname, 'index.html'), '/index.html'];
  for (const candidate of candidates) {
    const full = join(DIST, normalize(candidate));
    if (!full.startsWith(DIST)) continue;
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {
      // next candidate
    }
  }
  throw new Error(`nothing to serve for ${pathname}`);
}

const api = { sessions: 0, challenges: [] as string[], tokensSeen: new Set<string>() };
/** Requests to anything but the page origin and the stub, aborted. */
const escaped = new Set<string>();
/** Every `navigator.credentials` call, across page loads. */
const ceremonies: string[] = [];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = false;
const expect = (ok: boolean, what: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // Registered first, so the two routes below (matched last-registered first)
  // take precedence: anything they do not claim is aborted here.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:') escaped.add(url.origin);
    await route.abort();
  });
  await context.route('https://sente.lol/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const path = await file(decodeURIComponent(pathname));
    await route.fulfill({
      body: await readFile(path),
      contentType: TYPES[extname(path)] ?? 'application/octet-stream',
    });
  });
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const auth = request.headers().authorization;
    if (auth) api.tokensSeen.add(auth);
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
        body: JSON.stringify(body),
      });
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
      return;
    }
    const body = (request.postDataJSON() ?? {}) as { address?: string };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    if (pathname === '/auth/challenge') {
      api.challenges.push(body.address ?? '');
      await json(200, {
        address: body.address,
        nonce: 'n',
        message: 'Sign in to Sente',
        expiresAt,
      });
    } else if (pathname === '/auth/session') {
      api.sessions += 1;
      await json(200, { address: body.address, token: `stub-token-${api.sessions}`, expiresAt });
    } else {
      await json(503, { message: 'stub API' });
    }
  });

  await context.exposeFunction('__ceremony', (kind: string) => void ceremonies.push(kind));
  const page = await context.newPage();
  await page.addInitScript(() => {
    const report = (window as unknown as { __ceremony: (kind: string) => void }).__ceremony;
    const credentials = navigator.credentials;
    const create = credentials.create.bind(credentials);
    const get = credentials.get.bind(credentials);
    credentials.create = (options) => {
      report('create');
      return create(options);
    };
    credentials.get = (options) => {
      report('get');
      return get(options);
    };
  });
  const cdp = await context.newCDPSession(page);
  await addPrfAuthenticator(cdp);

  const since = (mark: number) => ceremonies.slice(mark);
  const sealed = (p: Page) =>
    p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('sente.session.')));
  /** The sealed session's address (header, not secret), or `null` when signed out. */
  const sealedAddress = (p: Page) =>
    p.evaluate(() => {
      const raw = sessionStorage.getItem('sente.session.seal.v1');
      return raw === null ? null : (JSON.parse(raw) as { address: string }).address;
    });
  /** Account renders only with a live session; `/welcome` otherwise. */
  const onAccount = async (p: Page): Promise<boolean> => {
    await p.getByText('Sign out', { exact: true }).first().waitFor({ timeout: 10_000 });
    return new URL(p.url()).pathname === '/account';
  };

  // 1. Create a passkey and land signed in.
  await page.goto('https://sente.lol/welcome');
  await page.getByText('Create passkey', { exact: true }).first().click();
  // First time: the tip sheet, whose button starts the ceremony.
  await page.waitForTimeout(500);
  const tipButton = page.getByText('Create passkey', { exact: true });
  if ((await tipButton.count()) > 1) await tipButton.last().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/welcome'), { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const atCreate = since(0);
  const address = await sealedAddress(page);
  console.log(
    `create: ceremonies ${JSON.stringify(atCreate)}, /auth/session calls ${api.sessions}, ` +
      `address ${address}, challenge for ${JSON.stringify(api.challenges)}`,
  );
  expect(api.challenges[0] === address, 'the sealed address is the one that signed in');
  expect(atCreate.length === 1, 'create + sign-in took exactly one WebAuthn ceremony');
  expect(
    (await sealed(page)).includes('sente.session.seal.v1'),
    'session sealed in sessionStorage',
  );
  const raw = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(!/stub-token-/.test(raw), 'no plaintext token in sessionStorage');
  const sessionsBefore = api.sessions;

  // 2. Reload (a full page load of /account): no ceremony, still signed in,
  // same address, the sealed token reused.
  let mark = ceremonies.length;
  await page.goto('https://sente.lol/account');
  const reloadedIn = await onAccount(page).catch(() => false);
  await page.reload();
  const reloadedTwice = await onAccount(page).catch(() => false);
  await page.waitForTimeout(1000);
  const afterReload = since(mark);
  const after = await sealedAddress(page);
  console.log(
    `reload x2: ceremonies ${JSON.stringify(afterReload)}, address ${after}, ` +
      `/auth/session calls ${api.sessions - sessionsBefore}, ` +
      `Authorization seen ${JSON.stringify([...api.tokensSeen])}`,
  );
  expect(afterReload.length === 0, 'two reloads ran no WebAuthn ceremony');
  expect(reloadedIn && reloadedTwice, 'still signed in (Account rendered) after each reload');
  expect(after === address, 'same address after reload');
  expect(
    api.sessions === sessionsBefore,
    'reload reused the sealed API token (no new /auth/session)',
  );

  // 3. Sign out, reload: /welcome, nothing sealed.
  await page.getByText('Sign out', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  mark = ceremonies.length;
  await page.reload();
  await page.waitForTimeout(2500);
  const path = new URL(page.url()).pathname;
  const leftover = await sealed(page);
  console.log(`sign out + reload: at ${path}, sealed keys left ${JSON.stringify(leftover)}`);
  expect(path.startsWith('/welcome'), 'signed out + reload lands on /welcome');
  expect(leftover.length === 0, 'sign-out cleared the sealed session and token');
  expect(since(mark).length === 0, 'no ceremony after sign-out reload');

  // 4. Sign in again with the stored hint: one ceremony, same address.
  mark = ceremonies.length;
  await page.getByText('Sign in with passkey', { exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/welcome'), { timeout: 20_000 });
  await page.waitForTimeout(1000);
  const atSignIn = since(mark);
  const again = await sealedAddress(page);
  console.log(`sign in: ceremonies ${JSON.stringify(atSignIn)}, address ${again}`);
  expect(atSignIn.length === 1, 'sign-in took exactly one WebAuthn ceremony');
  expect(again === address, 'sign-in reached the same address');

  // 5. Forget this passkey, reload: /welcome, nothing sealed.
  await page.goto('https://sente.lol/account');
  await onAccount(page);
  await page.getByText('Forget this passkey', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForTimeout(2500);
  const forgotten = new URL(page.url()).pathname;
  console.log(
    `forget + reload: at ${forgotten}, sealed keys left ${JSON.stringify(await sealed(page))}`,
  );
  expect(forgotten.startsWith('/welcome'), 'forget + reload lands on /welcome');
  expect((await sealed(page)).length === 0, 'forget cleared the sealed session');
  const keysLeft = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('sente-session-seal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const count = open.result.transaction('keys').objectStore('keys').count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        };
      }),
  );
  expect(keysLeft === 0, `no wrapping key left in IndexedDB (${keysLeft})`);
  // Aborted, so nothing left the machine; a Sente host here means the bundle
  // targets a real API instead of the stub, and the counts above mean nothing.
  console.log(`aborted (never sent): ${JSON.stringify([...escaped])}`);
  expect(
    ![...escaped].some((origin) => origin.includes('sente.lol')),
    'the bundle talks to the stub API, not a real one',
  );
} finally {
  await browser.close();
}
console.log(failed ? '\nFAIL' : '\nPASS');
process.exit(failed ? 1 : 0);
