# Trading-first Sente — mobile plan (SEN-61)

The screens of the study (`brief.md`, `markets.html`, `trade.html`, `portfolio.html`,
`agents.html`, `cockpit.html`) as buildable units for `apps/mobile`. The backend contracts they
code against are in `plan-backend.md` (routes B-…, wire contract at the end) and
`plan-trading.md` (manual trading, M-…). A mobile unit can start as soon as the contract it
needs is written down; it degrades gracefully while the route is not deployed (an older API
answers 404 → the section is hidden or shows "not available yet", never an error).

Conventions for every unit:

- Build on Goban (`src/ui/theme.ts`, `kit.tsx`, `goban.tsx`, `icons.tsx`). The study's
  `trading.css` and `chart.js` are the visual spec; reproduce them in React Native, don't
  invent new styles. Direction colours (mint/berry) only for price change, P&L and side.
- Money is decimal strings end to end; format with `src/agents/amounts.ts` helpers. Kuru is
  USDC, Perpl is AUSD; mixed totals say "≈ $".
- Every non-trivial choice (scales, formatting, what to show) is a pure `.ts` module with a
  `node --test` spec next to it. Screens only lay out.
- No new native modules. JS-only dependencies need a reason in the report.
- Done = `mise exec -- pnpm run typecheck`, `lint` and `--filter @sente/mobile run test` pass,
  and `cd apps/mobile && mise exec -- pnpm exec expo export --platform android` bundles.

## U-1 — Chart: geometry, Chart, Sparkline

- **Create:** `src/ui/chart/geometry.ts` + `geometry.test.ts`, `src/ui/chart/Chart.tsx`,
  `src/ui/chart/Sparkline.tsx`.
- **Read:** `docs/design/trading/chart.js` (the reference behaviour), `src/ui/ConsensusRamp.tsx`
  (Skia + Reanimated pairing), `src/ui/sigil.ts` (pure module style).
- **Mini-plan:**
  1. `geometry.ts` (pure): `scaleFor(points, levels, {height, padTop, padBottom, fit})`,
     `linePath(points, scale, width)`, `areaPath(...)`, `candleRects(klines, scale, width)`,
     `levelLayout(levels, scale)` returning `{y, onScale, edge: 'top'|'bottom'|null}` (the
     `fit:false` edge chips), `nearestIndex(x, n, width)` for scrub, `lastTagWidth(label)`.
  2. `Chart.tsx`: props `{ kind: 'line'|'area'|'candles'; points?: Decimal[]; klines?:
KlineDto[]; levels?: {price: Decimal; kind: 'entry'|'tp'|'sl'|'liq'|'limit'; label}[];
markers?: {index; who: 'you'|'agent'}[]; prevClose?: Decimal; height; fit?: boolean;
tone?: 'auto'|'purple'; onScrub?(index|null) }`. One Skia `Canvas`; gradient area; dashed
     levels with haloed labels; last-price pill; markers as stones (you = white, agent =
     purple). Scrub with `react-native-gesture-handler` Pan → `onScrub`, so the screen updates
     its headline (the chart never owns the headline).
  3. `Sparkline.tsx`: 64×28 line with end dot, tone by sign.
- **Acceptance:** geometry tests cover scale padding, fit vs edge chips, candle body/wick
  rects, nearest index at edges; Chart renders in the bundle; no new dependency.

## U-2 — Trading kit components

- **Create:** `src/ui/trading.tsx`, `src/ui/tradingFormat.ts` + test.
- **Mini-plan:** `BigNumber` (Bricolage condensed, dimmed decimals, `blurred` prop),
  `ChangeText` (±%, mint/berry), `TokenGlyph` (stone with a letter; no third-party logos),
  `MarketRow` (glyph, symbol + venue/quote subline, Sparkline, price + change, PERP n× tag),
  `Levels` (Entry / Target / Stop / Liq tiles with coloured top edge), `PressureBar`,
  `RangePills`, `SideTag` (LONG/SHORT), `AsOf` (live dot + "as of 3s", paused when stale),
  `TickerMarquee` (Reanimated translate loop, off under reduced motion).
  `tradingFormat.ts`: `splitDecimals(value, places)`, `pctChange(from, to)`, `formatPrice(value,
tick)`, `asOfLabel(ms, now)`, `leverageTag(n)`.
- **Acceptance:** tests for every formatter; components used nowhere yet but bundle.

## U-3 — Shell: floating dock, Trade button, Account behind the avatar

- **Modify:** `src/app/(tabs)/_layout.tsx` (dock: Home · Markets · Agents · Portfolio as a
  floating pill + a round Trade button that pushes `/trade`), move `src/app/(tabs)/account.tsx`
  → `src/app/account.tsx` (stack), create placeholders `src/app/(tabs)/markets.tsx`,
  `src/app/(tabs)/portfolio.tsx`, `src/app/trade.tsx` (modal presentation, "coming soon" until
  U-13). Leaderboard leaves the tabs: move `(tabs)/leaderboard.tsx` → `src/app/leaderboard.tsx`
  (stack) until U-8 folds it into Agents → Top.
- **Acceptance:** four tabs + Trade button; Account reachable from Home's avatar (U-7 adds
  the avatar; until then from Agents); sign-out still redirects; `Screen tabbed` leaves room
  for the floating dock.

## U-4 — Market data client and polling hooks

- **Create:** `src/markets/api.ts` (types copied from `plan-backend.md` wire contract:
  `MarketDto`, `TickerDto`, `DepthDto`, `KlinesDto`, `QuoteDto`; a `MarketsApi` built like
  `AgentsApi`), `src/markets/usePolling.ts`, `src/markets/hooks.ts` (`useMarkets`,
  `useTickers`, `useTicker`, `useKlines`, `useDepth`, `useQuote` with debounce),
  `src/markets/select.ts` + test (filters: favourites/spot/perps/gainers/losers; themes;
  search over markets and agents).
- **Mini-plan:** polling pauses when the screen loses focus or the app backgrounds; each hook
  returns `{data, asOf, stale, error}`; a 404 from an older API reads as "unavailable".
- **Acceptance:** select tests; hooks compile; the session wires one `MarketsApi`.

## U-5 — Markets tab and search

- **Modify:** `src/app/(tabs)/markets.tsx`. **Create:** `src/app/search.tsx` if search is its
  own route.
- **Spec:** `markets.html` → "Markets tab" (chips, themes, one row style, search with Markets /
  Agents segments, recents stored with `expo-secure-store`).
- **Deps:** U-1, U-2, U-3, U-4.

## U-6 — Asset detail (spot and perp)

- **Create:** `src/app/markets/[venue]/[symbol].tsx`, `src/markets/asset.ts` + test (what the
  header shows for spot vs perp, change-grid cells from klines).
- **Spec:** `markets.html` → spot MON and ETH-PERP: scrub-bound headline, ranges + candles
  toggle, change grid, your position (from `GET /portfolio`, hidden until M-T19), agents trading
  this market (from agent portfolios, B-T10), stats, pressure bar, sticky Sell/Buy (Short/Long)
  opening the ticket (U-13/U-14; gated by the trading flag).
- **Deps:** U-1, U-2, U-4.

## U-7 — Home

- **Modify:** `src/app/(tabs)/index.tsx` (and `src/agents/home.ts` as needed).
- **Spec:** `markets.html` → Home: avatar (→ Account) + bell, total value hero with blur
  toggle, area chart, ticker marquee, agents at work, watchlist, movers, idle-cash nudge.
- **Deps:** U-1, U-2, U-3, U-4.

## U-8 — Agents tab: Presets · Yours · Top

- **Create:** `src/app/(tabs)/agents.tsx` becomes the segmented screen (current list →
  "Yours"; leaderboard → "Top"), `src/presets/api.ts` (`GET /presets`, `/presets/:id/stats`,
  types from the contract), `src/ui/joseki.tsx` + `src/presets/joseki.ts` + test (each preset's
  stone pattern, pure), `src/presets/cards.ts` + test (risk dots, cadence label, stats line
  with sample size, "Too new to rate" under minN).
- **Spec:** `agents.html` → Agents tab and catalog.
- **Deps:** U-3; B-T16b for stats (degrades to no stats line).

## U-9 — Preset detail and configure → hire

- **Create:** `src/app/presets/[id].tsx`, `src/app/presets/[id]/configure.tsx`,
  `src/presets/params.ts` + test (param spec → control model, validation, read-back sentence).
- **Mini-plan:** Strategy (param controls from `ParamSpec`: number → slider/segmented, enum →
  chips, boolean → toggle, market → chips; live read-back in the agent voice) → Mandate (reuse
  `agents/MandateStep.tsx`, prefilled from `suggestedMandate`; `softRules` shown as "checked by
  the agent, not the enclave") → Review (name, model, cadence from `suggestedCadenceSeconds`,
  fund amount) → `agents.hire({ preset: {id, params}, schedule, mandate, ... })`.
- **Deps:** U-8; B-T15 (hire with preset), B-T12 (schedule). Mandate output must be
  byte-identical to today's for the same form (reuse `mandateToSend`).

## U-10 — Agent cockpit

- **Modify:** `src/app/agents/[id].tsx` → tabs Overview · History · Mandate (keep every sheet's
  behaviour from SEN-58). **Create:** `src/agents/portfolioApi.ts` (the `AgentPortfolioDto`
  client) or extend `agents/api.ts`, `src/agents/cockpit.ts` + test (stats chips, best trades
  from verdicts, open-position rows from the portfolio, equity series from verdict P&L).
- **Spec:** `cockpit.html` → Overview (P&L hero, equity chart, stats, open positions with
  stop-to-target track, Ask bar + Run now), History (best-trade cards + the existing stone
  spine), Mandate card (rules sentence, proof, gauges, amendments, actions). Cadence control
  (`PATCH /agents/:id/schedule`, `GET …/schedule` for "next check") lives on Overview.
- **Deps:** U-1, U-2; B-T10, B-T12/T13 (degrade when absent).

## U-11 — Agent position, live, and the Ask sheet

- **Create:** `src/app/agents/[id]/position/[symbol].tsx`, `src/agents/levels.ts` + test.
- **Mini-plan:** levels: entry/mark/liq from the portfolio position; target and stop come from
  the agent's preset params applied to entry (Range Trader target %/stop %, Guardian's levels)
  and are labelled "watched", or are omitted when the agent has no preset. Chart with agent
  fill markers (from `fill` events), "next check" from the schedule, the thesis in the agent's
  voice. Ask sheet → `agents.run(id, instruction)` with suggestion chips and the mandate
  reminder; the new run's entries appear through `useAgentEvents`. No direct close button.
- **Deps:** U-10.

## U-12 — Portfolio tab

- **Modify:** `src/app/(tabs)/portfolio.tsx`. **Create:** `src/portfolio/api.ts` (`GET
/portfolio`, `/portfolio/fills`), `src/portfolio/view.ts` + test (allocation split, totals ≈ $,
  blurred rendering rules), `src/app/positions/[venue]/[symbol].tsx` (your own position).
- **Spec:** `portfolio.html` (hero, allocation bar, cash card, Positions / Orders / History,
  agents group read-only → cockpit, privacy blur, your position with levels, cancel sheet).
  Cancel/close actions call the trading flow (U-13/U-14) and are hidden while the flag is off.
- **Deps:** U-1, U-2; M-T19.

## U-13 — Order ticket (spot, Kuru)

- **Modify:** `src/app/trade.tsx` (quick-trade picker) and create `src/app/trade/[venue]/[symbol].tsx`
  (the sheet), `src/trade/ticket.ts` + test (amount ↔ size conversion from the quote, presets,
  the CTA's validation label, disclosure line).
- **Spec:** `trade.html` → spot flows: Buy/Sell, Market/Limit, keypad, % presets, quote line,
  review with hold-to-confirm, execution steps (from `runTrade` status), filled / partial /
  resting results, insufficient-funds state.
- **Deps:** U-4; M-T21 (`runTrade`), M-T20. Shows "Trading from your wallet is coming" while
  `capabilities.enabled` is false.

## U-14 — Perp ticket, Perpl setup, close position

- **Modify:** the ticket from U-13 for perps; **create** `src/app/trade/perpl-setup.tsx`.
- **Spec:** `trade.html` → first perp ever (3 steps, 100 AUSD minimum), ETH long with leverage
  slider and liq. est, review, and close from the position screen; SL/TP is the disabled
  "Not on Perpl yet" row linking to hiring an agent with stops.
- **Deps:** U-13; M-T17, M-T18, M-T23.

## Order and parallelism

| Wave | Units                                                         |
| ---- | ------------------------------------------------------------- |
| 1    | U-1, U-2, U-3, U-4                                            |
| 2    | U-5, U-6, U-7, U-8, U-10 (after wave 1)                       |
| 3    | U-9 (after U-8, B-T15), U-11 (after U-10), U-12 (after M-T19) |
| 4    | U-13 (after M-T21), then U-14 (after M-T23)                   |

Shared files and landing order: `src/app/(tabs)/_layout.tsx` (U-3 only);
`src/app/(tabs)/agents.tsx` (U-8 only); `src/agents/api.ts` (U-10 adds the portfolio and
schedule client first; U-9 adds `preset`/`schedule` to the hire request after it);
`src/ui/icons.tsx` (append-only, any unit).
