# Trading-first Sente — design brief (SEN-61)

A design study, not an implementation. It extends the Goban system (`docs/design/`) to three new
jobs:

1. **Trading as the way in.** People browse markets, read a chart, get a quote, and buy, sell or
   place limit orders themselves, spot on Kuru and perps on Perpl.
2. **Preset agents.** A gallery of strategy templates people can configure and hire, instead of
   writing a system prompt from scratch.
3. **The agent cockpit.** Open an agent and see what it holds, what it did, what it made, and step
   into a live position: the chart with its entry, stop, target and liquidation drawn on it, and the
   agent's thesis beside it.

Inputs: `capabilities.md` (what the code and venues can do today; read its "Design constraints")
and a competitor study of FOMO and feel.cash (patterns summarised below; third-party screens are
not reproduced here).

## Information architecture

A floating pill tab bar with four tabs and a separate round **Trade** button (the core action),
as both reference apps do. Account moves behind the avatar on Home.

| Tab       | Job                                                                                        |
| --------- | ------------------------------------------------------------------------------------------ |
| Home      | Total value, what moved, your agents at work, watchlist, a live ticker of majors.          |
| Markets   | Every market (Kuru spot + Perpl perps) with filters, themes and search (markets + agents). |
| Agents    | Preset gallery, your hired agents, Top agents (the old Board).                             |
| Portfolio | Holdings, open positions, open orders, capital with agents, history.                       |
| (Trade)   | Floating button: pick a market (recents first) → the order ticket.                         |

Stack screens above the tabs: asset detail, order ticket (bottom sheet), position detail, agent
cockpit, agent position (live), preset detail and configure flow, ledger.

## Honesty legend

Every screen in the study carries annotations for what backs it, using four labels, so the study
doubles as a build plan. The app UI itself never shows these labels.

- **Live**: exists today.
- **API**: the venues/adapters already support it and it needs a read route (see
  `capabilities.md` → "Smallest backend additions").
- **Signing**: needs the user to trade from their own wallet (phone-verified contract calls, venue
  onboarding). New build, M–L.
- **Venue**: needs something the venue doesn't offer on testnet (e.g. native stop-loss/take-profit
  triggers).

## Hard constraints the design must respect

- **SL/TP are never venue orders.** On an agent's position they are _agent-watched levels_: the
  agent checks them when it runs, so they are soft, and the UI says so ("checked every run, not a
  venue order"). On a manual trade they are shown as a future feature (Venue) or omitted.
- **Market orders are bounded.** Every market order shows a max slippage and can partially fill;
  the result screen handles "filled 62%, rest cancelled".
- **Two quote currencies.** Kuru spot is in USDC and Perpl perps are in AUSD. Never label a Perpl
  figure USDC. Totals that mix them say "≈ $".
- **Four spot markets, ~7 perps.** No "search all tokens". Themes and filters over a small list.
- **Perps are isolated margin, leverage per order,** no add-margin, no amend. Liquidation price is
  our estimate: label it "est.".
- **Funds given to an agent are the agent's.** The user can't close an agent's position directly.
  They can ask it to (a run with an instruction), amend the mandate, revoke, or return funds.
- **Polling, not streaming.** Prices and positions show an "as of" time or a live dot backed by a
  1–5 s poll. There is no tick-by-tick depth.
- **Agents are LLM-driven.** No backtests exist, so preset pages never show one. Performance
  shown is live performance of agents running that preset, with sample sizes, like the Board.
- **Testnet only.** A quiet "Monad testnet" marker stays visible.

## Patterns to borrow

- Line chart by default: gradient area fill, pinned last-price tag, dashed previous-close line,
  drag to scrub (the headline price and change follow your finger), range pills, candles toggle.
- Activity on the chart: your fills and the agent's fills as markers; entry, SL, TP and liquidation
  as labelled horizontal lines.
- Giant centred amount with % presets; the disabled CTA's label says what's missing
  ("Enter an amount", "Insufficient AUSD", "Long ETH 5×"); one disclosure line under the CTA with
  est. fill, fee and slippage.
- Sticky full-width Buy / Sell pills on the asset page opening the ticket as a bottom sheet.
- Portfolio hero with dimmed cents, a sign-tinted area chart, and a blur-balances toggle.
- Two-line market rows with a 30-day sparkline and an end dot; chip filters; theme cards.
- Agent profile as a trader profile: stats chips (avg hold, trades, live since), best-trade cards,
  P&L chart, positions, fills tape. Theses become the "why" beside each position's live P&L.
- Mandate card: the rules in plain English, then proof (what it earned, what it was held from),
  then a dated ledger.
- Split pressure bars (bids vs asks, longs vs shorts).
- Neither reference app has perps, limit orders, stops or bots: those are ours to design.

## Goban, extended

Keep every Goban rule: purple is an event, a face is a speaker (the agent speaks in Newsreader
italic, the chain in Geist Mono), stones say what happened, limits are drawn. New for trading:

- **Direction colours.** Mint = up/long/buy, berry = down/short/sell, for price change, P&L and
  side, never for chrome. The primary CTA stays purple, except the ticket's final confirm, which
  takes the side's colour.
- **Big numbers** in Bricolage Grotesque condensed with dimmed decimals (`1,284.`**`50`** dimmed).
- **Chart lines**: entry `text`, TP `mint`, SL `berry`, liquidation `berry` dotted, limit
  `purpleSoft`, previous close `lineStrong` dashed. Agent fill markers are purple stones and your
  own fills are white stones, so the chart speaks the ledger's language.

## Deliverables (all under `docs/design/trading/`)

| Page             | Owns                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| `index.html`     | The study's front page: IA map, legend, flows, backend unlock plan.                   |
| `markets.html`   | Home, Markets list + search, spot asset detail, perp asset detail.                    |
| `trade.html`     | Order ticket: market buy, limit, perp long with leverage, review, execution, results. |
| `portfolio.html` | Portfolio tab, own position detail, open orders, history.                             |
| `agents.html`    | Preset gallery, preset detail, configure flow, Top agents.                            |
| `cockpit.html`   | Agent cockpit, agent position live view, mandate card, theses and fills.              |

Shared: `trading.css` (page chrome, phone, floating tab bar, trading components) and `chart.js`
(line, candles, sparkline, price lines, markers, scrub), both on top of `../sente.css`.

## Shared world (use these numbers on every page)

So the pages read as one app, every mockup uses the same user, balances, agents and markets.

- **You:** wallet `0x7a3f…c21e`. Cash **1,284.50 AUSD** and **500.00 USDC**, 0.42 MON for gas.
  Total value ≈ **$3,918.40** (includes positions and capital with agents), **+$84.12 (+2.19%)**
  today.
- **Your manual positions:** spot **412.00 MON** bought at 0.9420 (Kuru); perp **ETH long 3×**,
  size 0.25 ETH, entry 2,498.00, liq. est 1,690.00 (Perpl, AUSD margin 208.17). One open limit
  order: **buy 150 MON at 0.9500** (Kuru).
- **Your agents:**
  - **Range Hunter** (preset: Range Trader, Claude Sonnet 5, Kuru MON-USDC): 612.40 USDC,
    +18.22 today, +42.18 all time, 9 trades, 2 held. Open position: long 180 MON at 0.9744,
    target 1.0050, stop 0.9460 (agent-watched).
  - **Basis Monk** (preset: Funding Harvester, Kimi K2.6, Perpl): 300.00 AUSD, −4.10 today.
    Open position: short MON-PERP 2×, size 400 MON, entry 0.9920, liq. est 1.4800.
  - **Night Shift** (revoked Sep 23, 412.00 USDC still in its wallet).
- **Kuru spot (USDC):** MON 0.9812 (+2.41%), WETH 2,541.30 (−1.08%), cbBTC 64,210.00 (+0.62%),
  XAUt 2,386.40 (+0.11%).
- **Perpl perps (AUSD):** BTC-PERP 64,188.5 (20×), ETH-PERP 2,544.10 (20×), MON-PERP 0.9809
  (10×), SOL-PERP 148.62 (10×), plus three more if a list needs length (use generic majors, and
  keep leverage ≤ 20×). Funding shown as e.g. "+0.0100% / 8h".
- **Top agents:** Tengen (+24.1%, won 7 of 10), Range Hunter (yours, +8.4%, 6 of 9), Ladder
  Breaker (+3.9%, 4 of 7), gmonad maxi (−2.6%, 3 of 8).
- **Charts:** `chart.js` seeds. Use the market symbol as the seed (`"MON"`, `"ETH-PERP"`…) and
  set `start` near the price above so the scale is right (the chart writes its own last price
  into the headline through `scrub`).

## Decisions made while building the study

- **Markers say who, stones say what.** On a chart, a marker shows who traded: you are a white
  stone, an agent a purple one. In a list (ledger, history), the stone shows what happened, using
  Goban's five kinds (a trade is purple whoever made it, a deposit white).
- **SL/TP on your own trades** is a disabled "Not on Perpl yet" row that points to hiring an agent
  that trades with stops: an agent can't act on a position in your wallet, so "hand it to an
  agent" would be a promise it can't keep.
- **Guardian** is the preset answer to stops: you hand it an amount and levels, and it sells that
  amount at a check when a level is crossed. Soft, and labelled so.
- **Far levels** (a liquidation 30%+ away) use `chart.js`'s `fit: false`: an edge chip, not a
  line that flattens the chart.
- **The hire flow** is three steps (Strategy · Mandate · Review); a preset writes the
  instructions, so naming moves into Review.
