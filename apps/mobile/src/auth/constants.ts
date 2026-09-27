/**
 * The WebAuthn relying-party ID. PERMANENT — see CLAUDE.md.
 *
 * This is not configurable and must never be read from the environment. It is
 * an input to the PRF, and therefore to every user's wallet address: change it
 * and every existing account becomes unreachable rather than migrated.
 *
 * It lives in this dependency-free module rather than in `./mera` so a
 * plain-node test can pin it: `./mera` imports React Native and cannot load
 * there (SEN-138).
 */
export const RP_ID = 'sente.lol';
