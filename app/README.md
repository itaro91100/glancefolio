# Glancefolio

Your crypto portfolio and price alerts, readable in one glance on Even G2
glasses — no phone in your hand. Heads Up hackathon entry (Even Realities ×
TVM × Daos Hub), Track 2 — Crypto & Wallet, Telegram-qualifying for Best
Telegram.

**Day 2 status (24 Nov 2026):** all three screens are live and verified in
the simulator — Portfolio, Alerts, Coin detail — with full tap/double-tap
navigation and holdings entry on the companion page. The alerts engine +
Telegram bot land Day 3. Screen 4 (Movers) was cut on Day 1 — it adds nothing
to the alert narrative.

## What it does

- **Portfolio at a glance:** total value, 24h change, and P&L in one screen.
- **P&L formula:** `P&L = Σ (currentPrice − costBasis) × amount` over holdings
  that have a cost basis; holdings without one are excluded (shown as
  "set cost basis"). P&L % = P&L ÷ total cost basis × 100.
- **Live prices:** CoinGecko primary, Binance Vision fallback, Kraken second
  fallback; 60 s poll, tap to refresh now. Status line shows the source
  (`LIVE hh:mm:ss · CG`) or the failure (`ERR …` / `STALE …`).
- **Alerts (Day 2 on glasses, Day 3 engine):** arm a level from the glasses
  (tap a coin → cycles off → above → below → off; levels are ±5% of the
  current price, rounded to 3 significant figures) or in Telegram
  (`/alert BTC above 70000`); a tiny bot worker polls every 60 s and sends
  `🔔` on a confirmed cross. Even Hub plugins are foreground-only and **cannot
  push to the lens** — alerts arrive on the phone, and the glasses show them
  as FIRED when you open the app. This app never promises push-to-glass.
  Tap an alert on Screen 2 to arm/disarm it (a fired alert re-arms).
- **Holdings:** entered on the phone companion page (this page — add/update/
  delete with amount + optional cost basis) or via the bot
  (`/add BTC 0.42 @60000`). Day 1 seeds demo holdings (BTC 0.42, ETH 2.5,
  SOL 12 with cost bases) and demo alerts (BTC above $70,000, SOL below $70)
  only when the phone has none yet — they are sample values, not real user
  data. An explicitly emptied list stays empty.

## Screens

| # | Screen | Content |
|---|--------|---------|
| 1 | **Portfolio** (home) | Total, 24h change, P&L, holdings + `ALERTS ▸` nav row |
| 2 | **Alerts** | Armed/fired alerts, one per row; tap toggles arm/disarm |
| 3 | **Coin detail** | Price, 24h change + hi/lo (Binance source only), holding value, position P&L, alert state |

Navigation: swipe = move cursor one item; tap = open (holding → detail,
`ALERTS ▸` → alerts screen), toggle (alert row), or cycle the coin's alert
(detail screen); double-tap = one level up, root = exit. There is no
horizontal swipe in the SDK event set, so screens change only via tap on a nav
row and double-tap back. Tap-to-refresh from Day 1 is gone — prices refresh
on the 60 s poll and on foreground-enter. 24h high/low comes from the Binance
Vision 24hr ticker, so it only shows while Binance is the active source;
CoinGecko's `simple/price` has no high/low fields (by design — the rate
budget allows no extra calls).

## Architecture (decided Day 1)

- **Shared store:** phone localStorage (`glancefolio:v1:*`) is the primary
  store for what the glasses show. The Telegram bot keeps the durable copy in
  `bot/state.json` and publishes it as `state/alerts.json` via GitHub Pages;
  the glasses app fetches the Pages URL when online and falls back to
  localStorage. No live two-way sync on Day 1 — the bot is the writer, the
  glasses are the reader.
- **Alert polling host:** a tiny Node worker on the VM (`bot/`, Day 3), kept
  alive by the same 15-minute keepalive pattern as the project's other
  services. No new accounts, no cost, graceful degradation when it is down.
- **SDK:** `@evenrealities/even_hub_sdk` **0.0.16** (upgraded Day 1 from the
  template's 0.0.10 — core API unchanged, `min_app_version` floor 2.2.10).
- **Rate budget:** ≤1 CoinGecko call/min (one call covers BTC+ETH+SOL);
  Binance Vision only on CoinGecko failure (3 calls); Kraken only if both fail
  (1 call). Worst case ~2,880 calls/day across bot + glasses — inside the free
  tiers. Alert firing needs 2 consecutive polls beyond the level (hysteresis)
  + a 15-minute per-alert cooldown.
- **Storage schema (`glancefolio:v1:*`):** `holdings` =
  `[{symbol, amount, costBasis}]` (costBasis null = excluded from P&L);
  `alerts` = `[{id, symbol, direction, price, armed, firedAt}]`;
  `settings` = `{pollSeconds: 60}`.

## Run

```bash
npm install
npm run dev          # Vite on :5173
```

Simulator (headless):

```bash
xvfb-run -a node node_modules/@evenrealities/evenhub-simulator/bin/index.js \
  --automation-port 18080 http://localhost:5173
curl http://localhost:18080/api/ping            # → pong
curl http://localhost:18080/api/screenshot/glasses  # 576×288 RGBA PNG
curl -X POST http://localhost:18080/api/input -d '{"action":"down"}'
```

Pack for distribution:

```bash
npm run pack   # → out.ehpk
```

Tests (Node, no DOM / no network — store logic + companion form wiring):

```bash
npm test   # store + companion suites
```

## Honest limits

- **Simulator-only so far.** No real G2 glasses are available to this team;
  everything is verified in the headless simulator. Real-glasses behavior
  (BLE timing, glyph rendering, native-list events) may differ — the README
  and submission say so plainly.
- **CORS verified from this VM, not from a phone WebView yet** — the APIs all
  serve `access-control-allow-origin: *`, but the real phone WebView check is
  still open (Day 1 item).
- **Telegram bot needs a token** from @BotFather on the builder's own Telegram
  account — that step is pending (see DESIGN.md §12).
