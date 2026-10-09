/**
 * The rule every script that talks to an API applies first (CLAUDE.md, "Tests
 * never touch production"): `sente.lol` and every host below it is production,
 * where a new wallet is sent real testnet funds.
 */
export function isProductionHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'sente.lol' || host.endsWith('.sente.lol');
  } catch {
    return false;
  }
}
