# Judging Sente

Sente runs in the browser at **<https://sente.lol>**. There is no account to
request and no seed phrase: an account is a passkey you create on your own
device. Everything runs on **Monad testnet** (chain 10143), and the tokens have
no value.

<!-- MEASURE: every step below marked MEASURE has been read from the code and
docs, not yet walked end to end on production. Replace each with what the
dry run saw, or cut the step. -->

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

1. Click **Create passkey**.
2. When Chrome asks where to save it, choose **Google Password Manager**.
3. Confirm with your device's screen lock.

One prompt is expected: the passkey gives two keys in one ceremony, one that
identifies you and one (the device key) that owns your wallet and your agents'
mandates. A provider that evaluates only one of them asks a second time; that is
also fine. <!-- MEASURE: the number of prompts Google Password Manager showed. -->

If the passkey cannot derive keys, the app says **"This passkey cannot hold a
wallet"** instead of hanging. Pick Google Password Manager and try again.

You stay signed in if you reload the tab, for up to 8 hours. Closing the tab
signs you out; signing in again with the same passkey gives the same wallet.

## 3. What you get

- **A wallet only your device can move money from.** Sente's server created it
  and cannot sign for it; Privy pays its gas, so it needs no MON.
- **A starter kit:** 250 AUSD and 100 USDC, sent once to each new wallet. Home
  says so while it is on its way. AUSD settles Perpl perps; USDC is the quote
  currency on Kuru. <!-- MEASURE: how long the kit took to arrive on the dry run. -->
- **10 USD of AI credits**, once, for your agents' model calls (Credits screen).

Your address is on **Account** ("Address to fund") if you want to send yourself
more testnet tokens.

## 4. Five minutes: the claim

The claim: **the key that trades can never raise its own limit.** An agent
trades from its own wallet, under a mandate that Privy's signing enclave
enforces, and only your device key can change that mandate.

1. **Hire a preset agent.** **Agents → Presets**, pick one (Guardian, Range
   Trader and DCA Stacker trade Kuru spot; Trend Rider trades Perpl perps; Mean
   Reverter trades either; Funding Harvester shorts a perp and can hold the coin
   on Kuru), adjust its settings and read its mandate: which
   markets, how much per transaction, maximum leverage, expiry. Acknowledge the
   risks and hire it.
2. **Fund it while hiring.** Move some of your starter kit to the agent's wallet:
   USDC for Kuru, and **at least 100 AUSD** for a perps agent, because opening a
   Perpl account takes 100 AUSD. Sente sends the agent a little MON for its own
   gas. <!-- MEASURE: the amounts used on the dry run, and whether the MON
   arrived before the first run. -->
3. **Run now.** On the agent's page, press **Run now** and watch the terminal:
   what the model wrote, each tool it called, whether each call went through or
   was refused (and by whom), and the tokens and cost of each turn. A run is at most 12 model turns and
   3 minutes. <!-- MEASURE: one run's outcome on the dry run (orders placed,
   tx hash, cost). -->
4. **Look at the refusals.** The agent's **Ledger** (Full ledger) lists every
   thesis, order, fill and refusal. A preset usually stays inside its mandate, so
   to see a refusal, type an instruction in **Instruction (optional)** before
   Run now, for example asking it to place an order larger than its per-order
   cap. The refusal is final and goes on the Ledger. <!-- MEASURE: the exact
   instruction used on the dry run and the refusal it produced. -->

   On production, Sente's own check runs first, so it is usually Sente that
   refuses, before the enclave is asked. The enclave refusing on its own, with
   that check turned off, is a scripted demo:
   [`demo-refusal.md`](demo-refusal.md) and its committed transcripts.

5. **Raise the cap yourself.** Press **Amend**, raise the limit, then
   **Approve with passkey**. The app recompiles the mandate itself and signs only
   if the server's proposed policy matches it exactly. Sente's server cannot make
   this change: its key gets 401 from Privy. Run the same instruction again; the
   order now goes through. <!-- MEASURE: whether Chrome showed a passkey prompt
   for the amend in a session already signed in, and the tx hash of the order
   that landed. -->

When you are done, **Return funds** sends everything back to your wallet, and
**Revoke** stops the agent. Both work from the agent's page; return also works on
a revoked agent.

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
from **Portfolio → Orders**. <!-- SEN-185: name a Kuru market that has a
two-sided book after the market migration. --> <!-- MEASURE: the dry run's Kuru
order, with its tx hash. -->

**Perpl perps.** Open a Perpl market (for example BTC-PERP); the ticket sends
you to **Set up perps** the first time: it opens your Perpl account with 100 AUSD and enables order
forwarding (three transactions from your wallet), then enrolls a trade key your
device derives and Sente never sees. Then the ticket places market orders
bounded at 1% from the mark, or, under **Advanced options**, limit orders. Close
a position from its page. <!-- MEASURE: the dry run's perps setup and a round
trip, with tx hashes. -->

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
<!-- MEASURE: compare the address on Home in both after the dry run. -->

## Known limits

- **Testnet only.** Monad testnet, with the Kuru and Perpl testnet deployments.
  One server, in Madrid.
- **Kuru changed its testnet markets on 2026-10-09.** <!-- SEN-185: what a judge
  sees after the migration (which markets are listed, whether older agents must
  be amended). -->
- **Perps in the browser go through Sente's relay** (above).
- **No stop-loss or take-profit orders** on either venue.
- **Credits end at the free tier.** Paid credits are not open on this deployment.
- **Nansen covers Monad mainnet only**, so the agents' Nansen tool answers that
  it has no data.
- **ERC-8004 identities are not minted** on this deployment: the registries are
  read live, but no registration transaction has been sent.
- **iOS is out of scope**; Safari and iCloud Keychain are untested.

The full list, with the measurements behind each item, is in the README's
[Status and limits](../README.md#status-and-limits).
