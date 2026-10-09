# Passkeys in the browser (SEN-165)

What signs a user in on the web build, which passkey providers it has been measured
against, and what a human still has to measure. Measured 2026-10-01 unless a row
says otherwise.

## How it works

The web build runs the **same ceremonies** as Android (`apps/mobile/src/auth/mera.ts`):
one `wallet`-salt ceremony, then one `device`-salt assertion pinned to the credential the
first one chose. Only the WebAuthn transport differs:

| Platform | `src/auth/webauthnClient*.ts` | Transport                                                             |
| -------- | ----------------------------- | --------------------------------------------------------------------- |
| Android  | `webauthnClient.ts`           | mera's `reactNativeWebAuthnClient` → `react-native-passkey`           |
| Web      | `webauthnClient.web.ts`       | `undefined` → mera's default browser client → `navigator.credentials` |

rpId (`sente.lol`), the `sente.prf.v1.*` salts and the derivation are identical, so the
same credential derives the same wallet on both. `react-native-passkey` is not in the web
bundle (checked by grepping `dist-web`), and the Android bundle still carries
`reactNativeWebAuthnClient`.

**Two prompts on web too.** The welcome caption and the tip say so, because a second
browser dialog straight after the first reads as a bug.

**Only `https://sente.lol` and its subdomains can sign in.** The rpId is permanent, and
a browser refuses it anywhere else. `http://localhost:8081` (`expo start --web`) can
render the app but can never complete a passkey ceremony. Measured in headless Chromium:

| Page                     | `navigator.credentials.get({ rpId: 'sente.lol' })`                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://localhost:8165` | `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain. Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.` |
| `http://127.0.0.1:8166`  | `SecurityError: This is an invalid domain.`                                                                                                                                                                    |

(The first message shows Chrome tries WebAuthn Related Origin Requests,
`https://sente.lol/.well-known/webauthn`, before refusing. That file does not exist; it
would be the way to let a non-`sente.lol` origin use these passkeys, if one is ever needed.)

The app shows `SecurityError` as "Passkeys only work on sente.lol".

## Measured: the whole flow against a virtual authenticator

The harness, all local, nothing deployed:

- `apps/mobile/dist-web` (from `pnpm --filter @sente/mobile run export:web`) behind a
  node HTTPS server on 127.0.0.1:8165 with a self-signed `sente.lol` certificate;
- a second HTTPS listener (8167) for `api.sente.lol` proxying to a local API on 8166
  (`node dist/main.js`, its own `STATE_DIR`, `GAS_DRIP_DRY_RUN=true`, Privy credentials
  from `.env`);
- Playwright's headless Chromium with
  `--host-resolver-rules="MAP sente.lol:443 127.0.0.1:8165, MAP api.sente.lol:443 127.0.0.1:8167"`
  and `--ignore-certificate-errors-spki-list=<cert SPKI hash>`, so the page's origin is
  really `https://sente.lol` with no `/etc/hosts` edit. Chrome accepts WebAuthn on that
  origin (a raw `create` with PRF returned `{"enabled":true,"results":{"first":32 bytes}}`);
- authenticators from CDP: `WebAuthn.addVirtualAuthenticator` with `ctap2`, `internal`,
  resident key, user verification, and `hasPrf: true` or `false`;
- a page init script wrapping `navigator.credentials.create/get` to count ceremonies.

The web page renders only once Skia's CanvasKit is loaded (SEN-164, not done on this
branch); the harness preloaded `canvaskit-wasm` in its served `index.html` for that, and
changed nothing else.

| Scenario                                         | Ceremonies the page ran              | Result                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create passkey, PRF authenticator                | `create`, `get` (pinned)             | Landed on Home in ~0.5 s; `/auth/challenge` for `0xa762FA7ba694ACb76Bd3Fb77A7964F7c845226e0`; `POST /wallet/register` 200, Privy wallet `0x39ba55f13FbA6Fd3E079CDB078257d1b6773b06a` shown on Home |
| Reload, "Sign in with passkey" (stored hint)     | `get` (pinned), `get` (pinned)       | Home, **same** EOA and same Privy wallet                                                                                                                                                           |
| Clear localStorage, "I already have one"         | `get` (discoverable), `get` (pinned) | Home, **same** EOA and same Privy wallet                                                                                                                                                           |
| Create passkey, authenticator **without PRF**    | `create`                             | "This passkey cannot hold a wallet · PRF_UNAVAILABLE" after ~0.5 s. No spinner                                                                                                                     |
| Sign in with a credential that has no PRF secret | `get`                                | Same PRF_UNAVAILABLE message                                                                                                                                                                       |
| User verification refused                        | `create` → `NotAllowedError`         | "Passkey cancelled · PASSKEY_OPERATION_FAILED"                                                                                                                                                     |
| Sign in, no passkey for `sente.lol` present      | `get` → `NotAllowedError`            | "Passkey cancelled", immediately                                                                                                                                                                   |
| Timeout (no user presence, raw `create`, 2 s)    | → `NotAllowedError`                  | Same name and message as the two above                                                                                                                                                             |

`NotAllowedError` carries the same message for cancel, timeout, failed verification and
"nothing to offer" — by design, for privacy — so the "cancelled" copy covers all of them
and points at the phone QR flow. A literally dismissed dialog was not measurable headless
(there is no dialog); the spec gives it the same error.

Found on the way and fixed (SEN-165): every API client called the global `fetch` as
`this.fetchImpl(...)`, which a browser rejects with `Illegal invocation` — the web build
signed in and then reached no route. `src/platform/fetch.ts`.

What the virtual authenticator does **not** prove: anything about a real provider. Its
PRF is Chrome's own CTAP2 `hmac-secret` emulation. Exporting a credential with
`WebAuthn.getCredentials` and importing it into another authenticator does not carry the
PRF secret (the exported fields are `credentialId, isResidentCredential, rpId, privateKey,
userHandle, signCount, backupEligibility, backupState, userName, userDisplayName`), so the
cross-device "same address" question cannot be simulated this way.

## Provider matrix

| Provider                                            | PRF in the browser | Status                                                                                                                        |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| CDP virtual authenticator, `hasPrf: true`           | yes                | **Measured** — full flow, above                                                                                               |
| CDP virtual authenticator, `hasPrf: false`          | no                 | **Measured** — readable error, above                                                                                          |
| Chrome desktop + Google Password Manager            | yes                | **Measured** 2026-10-09 (Linux, Chrome; prod: sign-in, wallet registered, starter kit sent)                                   |
| Chromium desktop (Linux)                            | n/a                | **Measured** 2026-10-09 — no GPM passkeys in Chromium; use Google Chrome                                                      |
| Bitwarden extension                                 | no                 | **Measured** 2026-10-09 — intercepts the ceremony; no PRF. Pick "Use your device" in its popup or turn its passkey prompt off |
| Chrome desktop → Android phone via QR (hybrid), GPM | expected           | 2026-10-09: from Chromium on Linux the phone hangs on "Connecting to another device"; retry from Chrome                       |
| GPM passkey created by the Android app, used on web | expected           | Not measured — needs a human                                                                                                  |
| Windows Hello                                       | unknown            | Not measured — no Windows machine                                                                                             |
| iCloud Keychain (Safari / Chrome on macOS)          | unknown            | Not measured — no Mac                                                                                                         |
| Chrome profile-local passkeys (desktop)             | unknown            | Not measured                                                                                                                  |

The app's web copy recommends only the two "expected" rows (GPM in Chrome, or a phone
through the QR code). Do not add a provider to judge copy until it has a measured row.

## Left for a human

On a machine with Chrome signed in to the Google account that holds the phone's passkey:

1. Serve the export on a real `sente.lol` origin: either deploy (SEN-168), or map
   `sente.lol` to 127.0.0.1 in `/etc/hosts`, serve `apps/mobile/dist-web` over HTTPS with
   a certificate Chrome trusts (e.g. Caddy `tls internal`, root trusted), and **remove the
   hosts entry afterwards**. An `--ignore-certificate-errors-spki-list` launch flag works
   too, as above. The API must be reachable at the build's `EXPO_PUBLIC_API_URL`
   (default `https://api.sente.lol`).
2. **Chrome + GPM:** Create passkey, save it to Google Password Manager, pass both
   prompts, confirm Home. Record whether Chrome offered GPM, and how many prompts appeared.
3. **Same address as the phone:** sign in on the web with the passkey the Android app
   created (in GPM, synced) and compare the address on Home with the phone's. They should
   match: same credential, same rpId, same salt. If they do not, record why here.
4. **QR / hybrid:** "Use a phone or tablet", scan with the Android phone, confirm Home.
   The device-salt assertion is a second QR round trip — record whether that is tolerable.
5. Windows Hello / iCloud Keychain, if a machine is reachable: record PRF yes/no.

## Why icons are SVG on web (SEN-173)

On web, Skia is CanvasKit and **every `<Canvas>` is its own WebGL context**. Chrome keeps
about 16 live contexts per page; past that it logs `WARNING: Too many active WebGL contexts.
Oldest context will be lost.` and the oldest canvases turn into broken-image placeholders.
A desktop Home (rail, header, buttons, sparklines) mounted far more than 16, so after a few
interactions the icons broke.

**The rule: on web, only the price chart (`ui/chart/Chart.tsx`, one per screen) is a Skia
canvas.** Every small or repeated drawing has a `.web.tsx` twin that Metro picks for web and
that draws the same geometry as DOM SVG (or a CSS gradient), sharing its data with the native
file: `icons` (`iconPaths.ts`), `chart/Sparkline` (`sparklineModel` in `geometry.ts`),
`SigilBoard` (`sigilBoard` in `sigil.ts`), `joseki`, `GobanHero`, `TickerFade` and
`ConsensusTrack`. Native keeps Skia unchanged. A new drawing that can appear more than once on
a screen gets a web twin too.

Measured with headless Chromium against `expo export --platform web`, on a temporary route
that mounts what a desktop Home does several times over (52 icons, 20 sparklines, 20 sigils,
5 joseki, the ticker, 6 consensus tracks, a chart, the Welcome board):

| Build                    | `<canvas>` | WebGL contexts created | Lost | "Too many active" warnings |
| ------------------------ | ---------- | ---------------------- | ---- | -------------------------- |
| Skia everywhere (before) | 106        | 106                    | 90   | yes                        |
| SVG twins (after)        | 1          | 1                      | 0    | none                       |

`/welcome` went from 2 contexts to 0, and `/presets/range-trader` from 2 to 0.
