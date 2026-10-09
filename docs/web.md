# Passkeys in the browser (SEN-165)

What signs a user in on the web build, which passkey providers it has been measured
against, and what a human still has to measure. Measured 2026-10-01 unless a row
says otherwise.

## How it works

The web build runs the **same ceremonies** as Android (`apps/mobile/src/auth/ceremony.ts`):
one ceremony that evaluates the `wallet` salt as PRF `eval.first` and the `device` salt as
`eval.second` (SEN-176), with a second, pinned `device`-salt assertion only when the
provider does not answer `second`. Only the WebAuthn transport differs:

| Platform | `src/auth/webauthnClient*.ts` | Transport                                                             |
| -------- | ----------------------------- | --------------------------------------------------------------------- |
| Android  | `webauthnClient.ts`           | mera's `reactNativeWebAuthnClient` → `react-native-passkey`           |
| Web      | `webauthnClient.web.ts`       | `undefined` → mera's default browser client → `navigator.credentials` |

rpId (`sente.lol`), the `sente.prf.v1.*` salts and the derivation are identical, so the
same credential derives the same wallet on both. `react-native-passkey` is not in the web
bundle (checked by grepping `dist-web`), and the Android bundle still carries
`reactNativeWebAuthnClient`.

**One prompt where the provider evaluates both salts** — see "One prompt for both keys"
below. The web tip still says some browsers ask twice, because a second dialog straight
after the first reads as a bug.

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

## One prompt for both keys (SEN-176)

WebAuthn's PRF extension takes two salts per ceremony, `eval: { first, second }`, and each
output depends only on the credential and its own salt. mera 0.2.0 only passes `first`, so
`patches/@category-labs__mera@0.2.0.patch` (pnpm `patchedDependencies`) adds an optional
`prfSecondSalt` to `getPasskeyPrfOutput` and `createPasskeyWithPrfOutput`, and
`prfSecondOutput` to their results, in both the browser and the React Native client. Existing
callers are unchanged. Registration asks for both salts as well, so a provider that evaluates
PRF at creation needs one prompt for create-and-sign-in; one that evaluates PRF only at
assertion time needs two (mera's fallback assertion asks for both salts).

Because the salts and rpId are inputs to every wallet, the change ships with a proof that it
derives the same keys: `apps/mobile/scripts/prf-equivalence.ts`
(`pnpm --filter @sente/mobile run prf:equivalence`). It runs the app's own ceremony code in
node with mera's browser client, forwarding each `navigator.credentials` call into headless
Google Chrome on a real `https://sente.lol` origin with a CDP virtual authenticator
(`hasPrf: true`). Output of the run on 2026-10-09:

```text
browser: /usr/bin/google-chrome-stable (155.0.8059.39), origin https://sente.lol
virtual authenticator: ctap2.1, internal, uv, hasPrf=true

1 NEW create
    create eval=[first,second] results=[first,second]
    ceremonies   1
    credential   QHlYuB2ZL_Qw5K1vaae_lKUuf_gskEYlw7n1D3WPe5U
    address      0x06CC8cFEc821c3Fa7a415599961FFD6719bAcD44
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsjOAz6E90JdZW+0YNT3X3bcTmMKNuAjd5nYa5oZceOkIntYJ7pejXP2H1Gv04Wrl0RGL9ivnEMIRsttiZCS+Ng==
    device PRF   0xbacfdd682cd50f4c… (first 8 bytes)
2 OLD sign-in
    get (discoverable) eval=[first] results=[first]
    get (pinned) eval=[first] results=[first]
    ceremonies   2
    credential   QHlYuB2ZL_Qw5K1vaae_lKUuf_gskEYlw7n1D3WPe5U
    address      0x06CC8cFEc821c3Fa7a415599961FFD6719bAcD44
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsjOAz6E90JdZW+0YNT3X3bcTmMKNuAjd5nYa5oZceOkIntYJ7pejXP2H1Gv04Wrl0RGL9ivnEMIRsttiZCS+Ng==
    device PRF   0xbacfdd682cd50f4c… (first 8 bytes)
3 NEW sign-in
    get (discoverable) eval=[first,second] results=[first,second]
    ceremonies   1
    credential   QHlYuB2ZL_Qw5K1vaae_lKUuf_gskEYlw7n1D3WPe5U
    address      0x06CC8cFEc821c3Fa7a415599961FFD6719bAcD44
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsjOAz6E90JdZW+0YNT3X3bcTmMKNuAjd5nYa5oZceOkIntYJ7pejXP2H1Gv04Wrl0RGL9ivnEMIRsttiZCS+Ng==
    device PRF   0xbacfdd682cd50f4c… (first 8 bytes)
4 NEW sign-in, pinned
    get (pinned) eval=[first,second] results=[first,second]
    ceremonies   1
    credential   QHlYuB2ZL_Qw5K1vaae_lKUuf_gskEYlw7n1D3WPe5U
    address      0x06CC8cFEc821c3Fa7a415599961FFD6719bAcD44
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsjOAz6E90JdZW+0YNT3X3bcTmMKNuAjd5nYa5oZceOkIntYJ7pejXP2H1Gv04Wrl0RGL9ivnEMIRsttiZCS+Ng==
    device PRF   0xbacfdd682cd50f4c… (first 8 bytes)
5 NEW, provider drops second
    get (pinned) eval=[first] results=[first]
    get (pinned) eval=[first] results=[first]
    ceremonies   2
    credential   QHlYuB2ZL_Qw5K1vaae_lKUuf_gskEYlw7n1D3WPe5U
    address      0x06CC8cFEc821c3Fa7a415599961FFD6719bAcD44
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsjOAz6E90JdZW+0YNT3X3bcTmMKNuAjd5nYa5oZceOkIntYJ7pejXP2H1Gv04Wrl0RGL9ivnEMIRsttiZCS+Ng==
    device PRF   0xbacfdd682cd50f4c… (first 8 bytes)
6 OLD create (2nd credential)
    create eval=[first] results=[first]
    get (pinned) eval=[first] results=[first]
    ceremonies   2
    credential   Tvr1DpTxFJZKeZsoNFTq0Wy0ZmGOTzkEkaDyQXLX4Kc
    address      0x2CED93e46af4A6Fe3237D321E9A193018716e52D
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEABt2AA3SiRDjD84kJi8miwaQRNUmTA66I73KCISZHr+jhdb1OdAWuRpPZxaxbfcnow5rIhtSQsIaF4IZhXauSg==
    device PRF   0x2617128b6382cb15… (first 8 bytes)
7 NEW sign-in (2nd credential)
    get (discoverable) eval=[first,second] results=[first,second]
    ceremonies   1
    credential   Tvr1DpTxFJZKeZsoNFTq0Wy0ZmGOTzkEkaDyQXLX4Kc
    address      0x2CED93e46af4A6Fe3237D321E9A193018716e52D
    device SPKI  MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEABt2AA3SiRDjD84kJi8miwaQRNUmTA66I73KCISZHr+jhdb1OdAWuRpPZxaxbfcnow5rIhtSQsIaF4IZhXauSg==
    device PRF   0x2617128b6382cb15… (first 8 bytes)

SAME  credentialId credential 1: runs 1-5
SAME  address      credential 1: runs 1-5
SAME  deviceSpki   credential 1: runs 1-5
SAME  devicePrf    credential 1: runs 1-5
SAME  credentialId credential 2: runs 6-7
SAME  address      credential 2: runs 6-7
SAME  deviceSpki   credential 2: runs 6-7
SAME  devicePrf    credential 2: runs 6-7
ceremony counts 1,2,1,1,2,2,1 (expected 1,2,1,1,2,2,1)

PASS: one-ceremony and two-ceremony paths are byte-identical
```

Run 5 strips `eval.second` in the page, as a provider without second-salt support would:
the app falls back to a second, pinned assertion and still lands on the same keys. Runs 6–7
make a credential with the pre-SEN-176 create path and read it with the new sign-in.

## Staying signed in across a reload

Before SEN-176 the keys lived only in memory, so a reload went back to `/welcome` and asked
for the passkey again. Now, on web only (`apps/mobile/src/auth/sessionSeal.web.ts`; the
native twin is a no-op):

- After a sign-in, the two secrets the session is rebuilt from — the secp256k1 key for the
  session's account index and the `device` PRF output — are encrypted with AES-256-GCM under
  a key WebCrypto generated as **non-extractable**. The key is stored in IndexedDB as a
  `CryptoKey`; its bytes cannot be read out, by the app or by anyone else. The `wallet` PRF
  output, which would derive every account index, is not sealed, and neither is the passkey.
- The ciphertext, IV, an 8-hour expiry and the record's header go to `sessionStorage`, which
  the browser clears when the tab closes. The header (key id, expiry, credential, account
  index, address) is the AES-GCM additional data, so editing it breaks decryption. The API
  session token is sealed next to it under the same key.
- On load, a valid sealed session is decrypted and rebuilt by the same `openWalletSession` a
  sign-in uses, and the app lands signed in with no prompt. Anything wrong — expired, edited,
  key missing, a credential other than the stored hint, a rebuilt address other than the one
  sealed — clears both halves and the app goes to `/welcome` as before.
- Signing out, "Forget this passkey", and expiry destroy the sealed copy and its key.

The trade-off, exactly: **nothing is stored in plaintext.** A sealed, tab-scoped copy of the
session's two secrets survives a reload for up to 8 hours. Script running in the page (an
XSS) could ask WebCrypto to decrypt that copy while the tab is open, and so act as the user
for that long, but it cannot export the wrapping key to use it anywhere else. Closing the tab
ends it. Without the seal the same script could already use the live in-memory session, so
what this adds is the window after a reload, not a new kind of access.

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
changed nothing else. The ceremony counts in this table predate SEN-176; the current ones
are in the next section.

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

## Measured: one prompt and a reload on the web export (SEN-176)

`apps/mobile/scripts/web-reload-e2e.ts` (`pnpm --filter @sente/mobile run e2e:web-reload`,
after `export:web`) serves `dist-web` at `https://sente.lol` by request interception in
headless Google Chrome with a `hasPrf: true` virtual authenticator, stubs the API's
`/auth/challenge` and `/auth/session` (every other route answers 503), and counts
`navigator.credentials` calls across page loads. Run on 2026-10-09:

```text
create: ceremonies ["create"], /auth/session calls 1, address 0xe86305e99F8a5eF356Df26db4594b47B6E562FA1, challenge for ["0xe86305e99F8a5eF356Df26db4594b47B6E562FA1"]
ok    the sealed address is the one that signed in
ok    create + sign-in took exactly one WebAuthn ceremony
ok    session sealed in sessionStorage
ok    no plaintext token in sessionStorage
reload x2: ceremonies [], address 0xe86305e99F8a5eF356Df26db4594b47B6E562FA1, /auth/session calls 0, Authorization seen ["Bearer stub-token-1"]
ok    two reloads ran no WebAuthn ceremony
ok    still signed in (Account rendered) after each reload
ok    same address after reload
ok    reload reused the sealed API token (no new /auth/session)
sign out + reload: at /welcome, sealed keys left []
ok    signed out + reload lands on /welcome
ok    sign-out cleared the sealed session and token
ok    no ceremony after sign-out reload
sign in: ceremonies ["get"], address 0xe86305e99F8a5eF356Df26db4594b47B6E562FA1
ok    sign-in took exactly one WebAuthn ceremony
ok    sign-in reached the same address
forget + reload: at /welcome, sealed keys left []
ok    forget + reload lands on /welcome
ok    forget cleared the sealed session
ok    no wrapping key left in IndexedDB (0)

PASS
```

What it does not cover: a real provider (below), and the stub API means Home shows no
wallet; being signed in is judged by the Account screen rendering and the sealed address.

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

## Perpl through Sente's proxy (SEN-175)

On the web, Perpl orders go through Sente's proxy, because Perpl testnet refuses browser
origins: measured 2026-10-09, `wss://testnet.perpl.xyz/ws/v1/trading` answers a handshake
carrying `Origin: https://sente.lol` with 403 (101 with no Origin or with
`https://testnet.perpl.xyz`), and `GET /api/v1/pub/context` sends no
`Access-Control-Allow-Origin` while `OPTIONS` is a 405. `infra/Caddyfile` therefore
proxies `https://api.sente.lol/perpl/{api,ws}/*` to Perpl testnet with Perpl's own
Origin, CORS for `https://sente.lol` only (`Date` exposed, for the trader's clock sync)
and preflight answered at the edge; `infra/verify.sh` checks all of it. The web bundle
picks this network in `apps/mobile/src/trade/perplNetwork.web.ts`, derived from
`EXPO_PUBLIC_API_URL`; screens get it through `createAppPerplTrader`. The trade-off:
Perpl authenticates the socket once and later order frames are unsigned, so the proxy
could inject orders on an open socket. It can never withdraw. The Android app connects
directly, and the proxy reaches testnet only.

## Left for a human

On a machine with Chrome signed in to the Google account that holds the phone's passkey:

1. Serve the export on a real `sente.lol` origin: either deploy (SEN-168), or map
   `sente.lol` to 127.0.0.1 in `/etc/hosts`, serve `apps/mobile/dist-web` over HTTPS with
   a certificate Chrome trusts (e.g. Caddy `tls internal`, root trusted), and **remove the
   hosts entry afterwards**. An `--ignore-certificate-errors-spki-list` launch flag works
   too, as above. The API must be reachable at the build's `EXPO_PUBLIC_API_URL`
   (default `https://api.sente.lol`).
2. **Chrome + GPM:** Create passkey, save it to Google Password Manager, confirm Home.
   Record whether Chrome offered GPM and how many prompts appeared: one if GPM evaluates
   both PRF salts at creation, two if not (SEN-176).
3. **SEN-176 with an existing GPM passkey** (one made before SEN-176): note the EOA and the
   Privy wallet address on Home from the current production build, then sign in on this
   build. Record the prompt count (one expected) and confirm **both addresses are the same**.
   A different device key cannot pass silently: `POST /wallet/register` would refuse it
   with `device_key_mismatch`. Then reload the tab: Home again, no prompt. Sign out and
   reload: `/welcome`. Close the tab, open `sente.lol` again: `/welcome` (or one prompt).
4. **Same address as the phone:** sign in on the web with the passkey the Android app
   created (in GPM, synced) and compare the address on Home with the phone's. They should
   match: same credential, same rpId, same salt. If they do not, record why here.
5. **QR / hybrid:** "Use a phone or tablet", scan with the Android phone, confirm Home.
   Record whether the phone answered both salts in one round trip, or needed a second.
6. Windows Hello / iCloud Keychain, if a machine is reachable: record PRF yes/no.

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
