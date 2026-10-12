# Judging Sente

Sente runs in the browser at **<https://sente.lol>**. There is no account to
request and no seed phrase: an account is a passkey you create on your own
device. Everything runs on **Monad testnet** (chain 10143), and the tokens have
no value.

The steps below were walked end to end on production on 2026-10-12, in Google
Chrome on desktop; the demo video is that run.

## 1. Open it in Google Chrome

Open **<https://sente.lol>** in **Google Chrome** on a desktop or laptop, signed
in to Chrome with your Google account (Google Password Manager stores the
passkey).

- **Not Chromium.** Chromium has no Google Password Manager passkeys, so it
  cannot hold a Sente wallet.
- **Bitwarden users:** the Bitwarden extension takes over the passkey prompt and
  does not support the PRF extension the wallet is derived from. When its popup
  appears, choose **"Use your device"** (or turn its passkey prompt off) so
  Chrome's own prompt opens.
- Other providers (1Password, Chrome's profile-local passkeys, Windows Hello,
  iCloud Keychain) have not been tested. Signing in from the desktop through an
  Android phone's QR code is expected to work and has not been confirmed.

Passkeys for Sente only work on `sente.lol`: the domain is an input to every
wallet address.

## 2. Create a passkey

1. Click **Create passkey** (the landing page's main button; once a passkey
   exists on the device it reads **Sign in with passkey**).
2. When Chrome asks where to save it, choose **Google Password Manager**.
3. Confirm with your device's screen lock.

One prompt is expected: the passkey gives two keys in one ceremony, one that
identifies you and one (the device key) that owns your wallet and your agents'
mandates. A provider that evaluates only one of them asks a second time; that is
also fine. With Google Password Manager on desktop Chrome it was one PIN prompt.

If the passkey cannot derive keys, the app says **"This passkey cannot hold a
wallet"** instead of hanging. Pick Google Password Manager and try again.

You stay signed in if you reload the tab, for up to 8 hours. Closing the tab
signs you out; signing in again with the same passkey gives the same wallet.

## 3. What you get

- **A wallet only your device can move money from.** Sente's server created it
  and cannot sign for it; Privy pays its gas, so it needs no MON.
- **A starter kit:** 250 AUSD and 100 USDC, sent once to each new wallet. Home
  says so while it is on its way. AUSD settles Perpl perps; USDC is the quote
  currency on Kuru.
- **10 USD of AI credits**, once, for your agents' model calls (Credits screen).

Your address is on **Account** ("Address to fund") if you want to send yourself
more testnet tokens.

## 4. Five minutes: the claim

The claim: **the key that trades can never raise its own limit.** An agent
trades from its own wallet, under a mandate that Privy's signing enclave
enforces, and only your device key can change that mandate.

1. **Hire an agent.** From Home, **Hire an agent** (four steps: name and model,
   strategy, the mandate's limits, review), or **Agents → Presets** and pick one (Guardian, Range
   Trader and DCA Stacker trade Kuru spot; Trend Rider trades Perpl perps; Mean
   Reverter trades either; Funding Harvester shorts a perp and can hold the coin
   on Kuru), adjust its settings and read its mandate: which
   markets, how much per transaction, maximum leverage, expiry. Acknowledge the
   risks and hire it.
2. **Fund it while hiring.** The review step has two amounts when the mandate
   includes Perpl: USDC for spot and AUSD for perps, prefilled with **100 AUSD**
   because opening a Perpl account takes 100 AUSD. Sente sends the agent a little
   MON for its own gas. On the dry run: 40 USDC and 100 AUSD, both landed within
   seconds, and the agent's page went from **Perps: opening account…** to
   **Perps ready** about 20 seconds after hiring.
3. **Run now.** On the agent's page, press **Run now** and watch the terminal:
   what the model wrote, each tool it called, whether each call went through or
   was refused (and by whom), and the tokens and cost of each turn. A run is at most 12 model turns and
   3 minutes. On the dry run a Kimi K2.6 run took about 2 minutes and
   $0.05: it read the books, called `get_indicators` (Kuru's earlier deployment has
   no candle history, so Kuru markets use the matching Perpl perp as a labelled
   reference), saw no clear signal, stayed flat and set three **watchers**.
   Watchers are only checked on a schedule: pick one under **Checks the markets**
   (the page warns while it is on Manual).
4. **Look at the refusals.** The agent's **Ledger** (Full ledger) lists every
   thesis, order, fill and refusal. A preset usually stays inside its mandate, so
   to see a refusal, click the **Ask** bar at the bottom of the agent's page and
   type an instruction that asks the agent to try it. On the dry run: _"Test your
   guardrail: call place_order for a 500 USDC buy on cbBTC-USDC on Kuru now, so we
   can see the mandate refuse it."_ The terminal showed `place_limit refused by
the mandate check (notional_over_cap): notional 500.19 exceeds the mandate's
cap of 50`, and **Held** went to 1. (Asking it to "ignore its limits" usually
   makes the model decline without trying, so nothing is refused.) The refusal is
   final and goes on the Ledger and the agent's public page.

   On production, Sente's own check runs first, so it is usually Sente that
   refuses, before the enclave is asked. The enclave refusing on its own, with
   that check turned off, is a scripted demo:
   [`demo-refusal.md`](demo-refusal.md) and its committed transcripts.

5. **Raise the cap yourself.** Press **Amend**, raise the limit, then
   **Approve with passkey**. The app recompiles the mandate itself and signs only
   if the server's proposed policy matches it exactly. Sente's server cannot make
   this change: its key gets 401 from Privy. Run the same instruction again; the
   order now goes through. (Not repeated on the 2026-10-12 dry run.)

When you are done, **Return funds** sends everything back to your wallet, and
**Revoke** stops the agent. Both work from the agent's page; return also works on
a revoked agent. A revoked agent with nothing left in it can be **archived**.

Every agent also has a **public page** (**Public link** on its page), readable
signed out: its mandate, record, what it was held back from, and the mandate's
hash on Monad with **Verify on chain**. The landing page links a live one under
**See a live agent**.

More on an agent's page: a schedule (from every minute to every 7 days) and
watchers that wake it only when a price or indicator condition fires, and an MCP
token shown once at hire, for driving the agent from your own AI client.

## 5. Trade yourself

**Kuru spot.** Open **Markets**, pick a Kuru market and use the ticket: a limit
order rests on the book, a market order fills now within your slippage or not at
all. The first trade on each venue asks you to acknowledge its risks. Your
wallet approves and deposits into your Kuru account, then places the order; each
step is a sponsored send. Before your device key signs any step, the app checks
it against what it computed itself (the contract, the function, the amounts, the
worst price) and refuses anything it does not recognise. Resting orders cancel
from **Portfolio → Orders**. cbBTC-USDC, WETH-USDC and XAUt-USDC have bids and
asks; MON-USDC is empty. Kuru charges Sente's 0.1% builder fee in the asset you
receive, and the review shows it.

**Perpl perps.** Open a Perpl market (for example BTC-PERP); the ticket sends
you to **Set up perps** the first time: it opens your Perpl account with 100 AUSD and enables order
forwarding (three transactions from your wallet), then enrolls a trade key your
device derives and Sente never sees. Then the ticket places market orders
bounded at 1% from the mark, or, under **Advanced options**, limit orders. Close
a position from its page. The last step is **press and hold** to confirm. On
the dry run a 50 AUSD BTC-PERP long at 2× filled at once
(tx `0xdf8d3f84a394fef60d530987941e52a1c29b810d6e3639c833ead0a5be4cf559`).

In the browser, Perpl traffic goes through a relay on Sente's API, because
Perpl's testnet refuses browser origins. The relay could inject orders into your
open session, but it can never withdraw: a withdrawal is an on-chain transaction
only your wallet signs. The Android app connects to Perpl directly.

Neither venue offers stop-loss or take-profit orders on testnet. The Guardian
preset is the stand-in: an agent that sells when the price crosses one of two
lines, checked each time it runs.

## 6. How it works

**<https://sente.lol/how-it-works>** explains, without signing in, what is
enforced by the enclave, what Sente checks, what is stored and where, and what
has not been proven yet. The same page is linked from the side rail, Account and
Welcome.

## 7. The Android app (optional)

**<https://sente.lol/download/sente.apk>**, for Android 9 or later with
sideloading allowed. It uses the same domain and derives keys the same way, so
the same Google Password Manager passkey should give the same wallet on the
phone and on the web. That has not been confirmed on a real device pair yet.

## Known limits

- **Testnet only.** Monad testnet, with the Kuru and Perpl testnet deployments.
  One server, in Madrid.
- **Kuru testnet: Sente trades Kuru Spot V2 on its earlier testnet deployment,
  because the newest one's test USDC is handed out on request only.** Its four markets (MON, WETH, cbBTC and XAUt
  against USDC) are read from the chain, since Kuru's APIs list only the new
  deployment: they have no price history, and resting orders show as locked
  balance rather than in **Portfolio → Orders**. An agent hired on the other
  deployment says so on its page and moves over with **Amend**.
- **Perps in the browser go through Sente's relay** (above).
- **No stop-loss or take-profit orders** on either venue.
- **Credits end at the free tier.** Paid credits are not open on this deployment.
- **Nansen covers Monad mainnet only**, so the agents' Nansen tool answers that
  it has no data.
- **ERC-8004:** each new agent is registered and its mandate's hash written to
  its identity at hire (shown on its public page); reputation verdicts are not
  written yet.
- **Kuru indicators use a reference price:** Kuru's earlier deployment has no
  candle history, so agents' indicators on Kuru markets come from the matching
  Perpl perp, labelled as such in the tool's answer.
- **iOS is out of scope**; Safari and iCloud Keychain are untested.

The full list, with the measurements behind each item, is in the README's
[Status and limits](../README.md#status-and-limits).
