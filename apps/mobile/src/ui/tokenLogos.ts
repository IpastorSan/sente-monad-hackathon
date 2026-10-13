/**
 * Which bundled logo a token symbol shows (SEN-214). Plain TS so node can test
 * it; the `require` map Metro needs lives in `tokenLogoAssets.ts`.
 *
 * The logos are CoinGecko's, baked into round badges by
 * `scripts/fetch-token-logos.ts` and committed under `assets/tokens/`. A symbol
 * with no logo here keeps its letter stone (`glyphFor`).
 */

/** One per `assets/tokens/<name>.png`. */
export const TOKEN_LOGOS = [
  'ausd',
  'avax',
  'btc',
  'cbbtc',
  'doge',
  'eth',
  'lit',
  'mon',
  'near',
  'pump',
  'sol',
  'usdc',
  'usdt',
  'wbtc',
  'xaut',
  'zec',
] as const;

export type TokenLogo = (typeof TOKEN_LOGOS)[number];

const BY_SYMBOL = new Map<string, TokenLogo>(TOKEN_LOGOS.map((name) => [name.toUpperCase(), name]));

/**
 * Wrappers that carry their underlying token's mark rather than one of their
 * own. WETH's CoinGecko image is a blurry sticker; WMON and the XAUt0 bridge
 * spelling have none.
 */
const SAME_AS: Record<string, TokenLogo> = {
  WETH: 'eth',
  WMON: 'mon',
  XAUT0: 'xaut',
};

/**
 * The logo for a symbol, or `null` for the letter stone. Takes a bare asset
 * (`cbBTC`), a perp (`BTC-PERP`) or a pair (`MON-USDC`); the base is what
 * shows. Case does not matter. A wrapper with no logo of its own falls back to
 * its base asset the way the stone does: `WSOL` → SOL, `cbETH` → ETH.
 */
export function tokenLogoFor(symbol: string): TokenLogo | null {
  const base = symbol.trim().split(/[-/]/)[0] ?? '';
  const upper = base.toUpperCase();
  const direct = BY_SYMBOL.get(upper) ?? SAME_AS[upper];
  if (direct) return direct;
  // Wrapper prefixes are lower case (`cbETH`) or a lone `W` before a ticker.
  const unwrapped = base
    .replace(/^[a-z]+(?=[A-Z])/, '')
    .replace(/^W(?=[A-Z]{3})/, '')
    .toUpperCase();
  return BY_SYMBOL.get(unwrapped) ?? null;
}
