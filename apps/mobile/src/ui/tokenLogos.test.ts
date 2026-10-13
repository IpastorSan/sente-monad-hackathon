/** Token logo mapping (SEN-214). Plain node, no device. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

import { TOKEN_LOGOS, tokenLogoFor } from './tokenLogos.ts';

const TOKENS_DIR = new URL('../../assets/tokens/', import.meta.url);

test('tokenLogoFor maps a base asset, any case', () => {
  assert.equal(tokenLogoFor('BTC'), 'btc');
  assert.equal(tokenLogoFor('btc'), 'btc');
  assert.equal(tokenLogoFor('MON'), 'mon');
  assert.equal(tokenLogoFor('AUSD'), 'ausd');
  assert.equal(tokenLogoFor('USDC'), 'usdc');
});

test('tokenLogoFor shows the base of a perp or a pair', () => {
  assert.equal(tokenLogoFor('BTC-PERP'), 'btc');
  assert.equal(tokenLogoFor('eth-perp'), 'eth');
  assert.equal(tokenLogoFor('LIT-PERP'), 'lit');
  assert.equal(tokenLogoFor('MON-USDC'), 'mon');
  assert.equal(tokenLogoFor('cbBTC-USDC'), 'cbbtc');
  assert.equal(tokenLogoFor('XAUt/USDC'), 'xaut');
});

test('tokenLogoFor keeps a wrapper’s own logo, else its base’s', () => {
  assert.equal(tokenLogoFor('cbBTC'), 'cbbtc');
  assert.equal(tokenLogoFor('WBTC'), 'wbtc');
  assert.equal(tokenLogoFor('XAUt'), 'xaut');
  assert.equal(tokenLogoFor('XAUT'), 'xaut');
  assert.equal(tokenLogoFor('XAUt0'), 'xaut');
  assert.equal(tokenLogoFor('WETH'), 'eth');
  assert.equal(tokenLogoFor('WMON'), 'mon');
  assert.equal(tokenLogoFor('WSOL'), 'sol');
  assert.equal(tokenLogoFor('cbETH'), 'eth');
});

test('tokenLogoFor leaves unknown symbols on the letter stone', () => {
  assert.equal(tokenLogoFor('ZZZ'), null);
  assert.equal(tokenLogoFor('XAU'), null);
  assert.equal(tokenLogoFor(''), null);
  assert.equal(tokenLogoFor('-PERP'), null);
  // `W` is a wrapper prefix only before a three-letter ticker.
  assert.equal(tokenLogoFor('WIF'), null);
});

test('every logo has a small PNG on disk, and every PNG is listed', () => {
  const files = readdirSync(TOKENS_DIR)
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -'.png'.length))
    .sort();
  assert.deepEqual(files, [...TOKEN_LOGOS].sort());
  for (const name of TOKEN_LOGOS) {
    const size = statSync(new URL(`${name}.png`, TOKENS_DIR)).size;
    assert.ok(size > 0 && size < 16_000, `${name}.png is ${size} B`);
  }
});

test('the asset map imports each logo from its own file', () => {
  const source = readFileSync(new URL('./tokenLogoAssets.ts', import.meta.url), 'utf8');
  const imports = [
    ...source.matchAll(/^import (\w+) from '\.\.\/\.\.\/assets\/tokens\/(\w+)\.png';$/gm),
  ];
  assert.deepEqual(
    imports.map(([, name, file]) => [name, file]),
    TOKEN_LOGOS.map((name) => [name, name]),
  );
  const map = source.slice(source.indexOf('TOKEN_LOGO_ASSETS'));
  const keys = [...map.matchAll(/^ {2}(\w+),$/gm)].map(([, key]) => key);
  assert.deepEqual(keys, [...TOKEN_LOGOS]);
});
