/**
 * Fetches the token logos the app bundles (SEN-214) into `assets/tokens/`.
 *
 * Each symbol maps to a CoinGecko coin id by hand. The script asks the public
 * API (`/coins/<id>`, no key) for the coin, checks its ticker is the one we
 * expect (a wrong id would put another token's face on a market), downloads
 * `image.large` and writes a 128 px round badge through ImageMagick: every
 * logo is clipped to a circle, and a logo that is not round itself (a bare
 * mark, a tile reaching into its corners) is inset on a disc first, so each
 * one reads as the same stone the letter glyph was.
 *
 * The app never hotlinks: the PNGs are committed and `src/ui/tokenLogoAssets.ts`
 * requires them statically, so a logo shows offline and in the APK. Re-run only
 * to refresh the images, then commit them:
 *
 *   mise exec -- node apps/mobile/scripts/fetch-token-logos.ts [file ...]
 *
 * Needs `magick` on the PATH. The free API allows a few calls a minute, so the
 * script waits between coins and backs off on a 429.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How a logo becomes a round badge. `crop` clips the image to its inscribed
 * circle (logos that are already round, and square tiles whose mark sits well
 * inside). `disc` scales the image to `scale` of the badge and centres it on a
 * disc of `backing`: the stone's own tint where the app has one, white where
 * the logo's own tile is white or its mark has see-through parts.
 */
type Fit = { kind: 'crop' } | { kind: 'disc'; backing: string; scale: number };

const CROP: Fit = { kind: 'crop' };

/** File name (lower case, no extension) → CoinGecko id, its ticker, its fit. */
export const TOKEN_LOGO_SOURCES: Record<string, { id: string; ticker: string; fit: Fit }> = {
  btc: { id: 'bitcoin', ticker: 'btc', fit: CROP },
  wbtc: { id: 'wrapped-bitcoin', ticker: 'wbtc', fit: CROP },
  cbbtc: { id: 'coinbase-wrapped-btc', ticker: 'cbbtc', fit: CROP },
  // WETH has no file of its own: CoinGecko's WETH image is a blurry sticker,
  // so the app shows ETH's mark for it (`tokenLogos.ts`).
  eth: { id: 'ethereum', ticker: 'eth', fit: { kind: 'disc', backing: '#CFD6FF', scale: 0.7 } },
  sol: { id: 'solana', ticker: 'sol', fit: { kind: 'disc', backing: '#C9F2E4', scale: 0.62 } },
  mon: { id: 'monad', ticker: 'mon', fit: CROP },
  zec: { id: 'zcash', ticker: 'zec', fit: CROP },
  // A pill on a white tile, reaching into the corners: inset on white.
  pump: { id: 'pump-fun', ticker: 'pump', fit: { kind: 'disc', backing: '#FFFFFF', scale: 0.84 } },
  // Perpl's LIT perp is Lighter's token, not Litentry (now Heima, HEI).
  lit: { id: 'lighter', ticker: 'lit', fit: CROP },
  near: { id: 'near', ticker: 'near', fit: CROP },
  xaut: {
    id: 'tether-gold',
    ticker: 'xaut',
    fit: { kind: 'disc', backing: '#FFFFFF', scale: 0.7 },
  },
  usdt: { id: 'tether', ticker: 'usdt', fit: { kind: 'disc', backing: '#FFFFFF', scale: 0.7 } },
  usdc: { id: 'usd-coin', ticker: 'usdc', fit: CROP },
  ausd: { id: 'agora-dollar', ticker: 'ausd', fit: CROP },
  doge: { id: 'dogecoin', ticker: 'doge', fit: CROP },
  avax: { id: 'avalanche-2', ticker: 'avax', fit: CROP },
};

const SIZE = 128;
const PAUSE_MS = 4_000;
const API = 'https://api.coingecko.com/api/v3/coins';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tokens');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithBackoff(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status !== 429 || attempt === 4) return res;
    const wait = 15_000 * (attempt + 1);
    console.warn(`  429 from CoinGecko, waiting ${wait / 1000}s`);
    await sleep(wait);
  }
}

/** ImageMagick arguments that turn `raw` into the round badge at `out`. */
function badgeArgs(raw: string, fit: Fit, out: string): string[] {
  const c = SIZE / 2 - 0.5;
  const circle = `circle ${c},${c} ${c},0`;
  const disc = (fill: string) => [
    '(',
    '-size',
    `${SIZE}x${SIZE}`,
    'xc:none',
    '-fill',
    fill,
    '-draw',
    circle,
    ')',
  ];
  const inner = fit.kind === 'crop' ? SIZE : Math.round(SIZE * fit.scale);
  // `[0]` takes the first frame of an animated or multi-image source.
  const logo = [
    '(',
    `${raw}[0]`,
    '-background',
    'none',
    '-resize',
    `${inner}x${inner}`,
    '-gravity',
    'center',
    '-extent',
    `${SIZE}x${SIZE}`,
    ')',
  ];
  const clip = [...disc('white'), '-compose', 'DstIn', '-composite'];
  const body =
    fit.kind === 'crop'
      ? [...logo, ...clip]
      : [...disc(fit.backing), ...logo, '-compose', 'over', '-composite', ...clip];
  // A 255-colour palette with alpha keeps the antialiased rim and the files
  // near 5-10 KB.
  return [...body, '-strip', '-colors', '255', '-define', 'png:compression-level=9', out];
}

async function fetchLogo(
  file: string,
  source: { id: string; ticker: string; fit: Fit },
  work: string,
) {
  const res = await fetchWithBackoff(
    `${API}/${source.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
  );
  if (!res.ok) throw new Error(`${source.id}: HTTP ${res.status}`);
  const coin = (await res.json()) as {
    symbol?: string;
    name?: string;
    image?: { large?: string; small?: string };
  };
  if (coin.symbol?.toLowerCase() !== source.ticker) {
    throw new Error(`${source.id}: ticker is ${coin.symbol}, expected ${source.ticker}`);
  }
  const url = coin.image?.large ?? coin.image?.small;
  if (!url) throw new Error(`${source.id}: no image`);

  const img = await fetch(url);
  if (!img.ok) throw new Error(`${source.id}: image HTTP ${img.status}`);
  const raw = join(work, `${file}.src`);
  writeFileSync(raw, Buffer.from(await img.arrayBuffer()));

  const out = join(OUT_DIR, `${file}.png`);
  execFileSync('magick', badgeArgs(raw, source.fit, out));
  console.log(`${file}.png  ${coin.name} (${source.id})  ${statSync(out).size} B  ${url}`);
}

async function main() {
  const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
  const files = wanted.length > 0 ? wanted : Object.keys(TOKEN_LOGO_SOURCES);
  const work = mkdtempSync(join(tmpdir(), 'token-logos-'));
  let failed = 0;
  try {
    for (const [i, file] of files.entries()) {
      const source = TOKEN_LOGO_SOURCES[file];
      if (!source) {
        console.error(`${file}: no CoinGecko id in TOKEN_LOGO_SOURCES`);
        failed++;
        continue;
      }
      if (i > 0) await sleep(PAUSE_MS);
      try {
        await fetchLogo(file, source, work);
      } catch (error) {
        console.error(`${file}: ${(error as Error).message}`);
        failed++;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failed > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
