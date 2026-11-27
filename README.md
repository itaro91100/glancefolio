# Glancefolio

Your crypto portfolio and price alerts, readable in one glance on Even G2
glasses — no phone in your hand.

Built for **Heads Up** (Even Realities × TVM × Daos Hub), Track 2 — Crypto &
Wallet. Also qualifies for **Best Telegram ($1,000, stackable)** via the
Telegram bot: alerts are armed from the glasses or from Telegram, and a
crossed level lands as a real Telegram message on your phone.

## What it does

- **Portfolio (Screen 1):** live BTC/ETH/SOL prices, total value, 24h change,
  P&L with cost basis. Cursor moves between holdings; tap opens the detail.
- **Alerts (Screen 2):** threshold alerts, one per row (`● BTC > $70,000`).
  Tap toggles arm/disarm; a fired alert shows `✓` + time and can be re-armed.
- **Coin detail (Screen 3):** price, 24h change + high/low, holding value,
  position P&L, alert state. Tap cycles alert off → above → below → off.
- **Telegram bot:** `/price`, `/alert`, `/alerts`, `/portfolio`, `/add`,
  `/remove`. When a level crosses, the bot sends `🔔 BTC — price above
  $70,000` to your phone. The glasses show the same alert as FIRED when
  you open the app.

Hard constraint, stated honestly: Even Hub plugins are foreground-only and
cannot push notifications to the lens. Alerts do **not** pop up on the
glasses by themselves — the Telegram message lands on the phone, and the G2
app shows fired alerts when you open it. The demo video shows the real flow.

## Repo layout

- `app/` — the Even Hub app (TypeScript + Vite + `@evenrealities/even_hub_sdk`
  0.0.16). `npm run build && evenhub pack app.json dist` → `.ehpk`.
- `bot/` — the alert worker + Telegram long-poller (Node, no dependencies).
  Polls prices every 60 s, checks alert levels (2 consecutive polls beyond
  the level, 15-minute cooldown per alert, 1% re-arm hysteresis), publishes
  state to GitHub Pages. Run: `GLANCEFOLIO_BOT_TOKEN=<token> node bot/src/index.mjs`
  (without a token it still polls + publishes, Telegram disabled).
- `state/alerts.json` (on the `gh-pages` branch) — the bot's published
  state, read by the glasses app when online:
  `https://itaro91100.github.io/glancefolio/state/alerts.json`

## Data

Prices: CoinGecko (primary) → Binance Vision → Kraken (fallbacks), ≤1 call/min.
Holdings + alerts live in phone localStorage (`glancefolio:v1:*`); the bot
keeps a durable copy in `bot/state.json`. No wallet connection, no private
keys, no trading — read-only by design.

## Status

Built during Heads Up build week, 23–29 Nov 2026. Day 1–2: screens +
navigation, verified in the Even Hub simulator. Day 3: alerts engine +
Telegram bot. No real G2 glasses in hand — verified on the simulator only,
noted honestly here (see `app/README.md` for the full caveats).
