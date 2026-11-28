# Glancefolio bot

Alert worker + Telegram long-poller for Glancefolio (Heads Up / Even
Realities). Node, zero dependencies — only the standard library + global
`fetch`.

## What it does

- Polls prices every 60 s: CoinGecko (primary) → Binance Vision →
  Kraken (fallbacks). One CoinGecko call covers BTC+ETH+SOL.
- Checks alert levels with hysteresis: a level fires only after **2
  consecutive polls** beyond it, then a **15-minute per-alert cooldown**
  before it can re-fire; a fired alert auto re-arms when the price returns
  1% inside the level (or when the user re-arms it).
- Sends `🔔 BTC — price above $70,000` to every known Telegram chat when a
  level fires.
- Keeps the durable state in `state.json` (holdings, alerts, runtime,
  prices, chat ids) and publishes the public copy as `state/alerts.json`
  via GitHub Pages (`gh-pages` branch, worktree at `bot/pages/`). The
  glasses app reads that URL when online; localStorage is the fallback.
- Telegram commands: `/price`, `/alert`, `/alerts`, `/delalert`,
  `/portfolio`, `/add`, `/remove`, `/start`, `/help`.

## Run

```bash
# Poll + publish only (no Telegram) — works without a token:
node src/index.mjs

# With Telegram (token from @BotFather — never hardcode, never commit):
TELEGRAM_BOT_TOKEN=<token> node src/index.mjs

# Optional: restrict the bot to one chat (your own Telegram id):
GLANCEFOLIO_CHAT_ID=123456789 node src/index.mjs

# Optional overrides:
TELEGRAM_API_BASE=https://api.telegram.org   # tests point this at a mock
BOT_POLL_SECONDS=60 BOT_HEARTBEAT_SECONDS=900
```

The token can also live in `bot/.env` (mode 600, gitignored) as
`TELEGRAM_BOT_TOKEN=...` — `keepalive.sh` sources it. Get a token
from @BotFather on Telegram (`/newbot`), then paste it there; restart
the worker.

### Publishing to Pages (auth)

The `bot/pages/` worktree pushes to `itaro91100/glancefolio` (branch
`gh-pages`). Auth goes through `gh`'s credential helper as the active
account `itaro91100` — that is why the push broke on 26 Nov: the remote
still pointed at `gmxbtt/glancefolio` while `gh` was authed as
`itaro91100`, so GitHub answered 403. The repo was moved to
`itaro91100/glancefolio` on 27 Nov (both branches re-pushed, Pages
re-enabled there); the old `gmxbtt/glancefolio` repo is left untouched.
The old per-worktree credential store
(`~/.config/gh-glancefolio-credentials`, gmxbtt token) is no longer
used and can be deleted.

## Keepalive

`keepalive.sh` checks whether the worker is alive (exit 0) or dead
(exit 1). A 15-minute cron runs it and restarts the worker as a tracked
background session when the check fails — never `nohup` (nohup-started
processes die within minutes on this VM; proven by the Dialectica serve).
Run the check by hand:

```bash
bash bot/keepalive.sh   # "alive: <pid>" or "NOT running"
```

Start the worker by hand (tracked background session in your agent
runtime, appending to `bot/bot.log`):

```bash
cd bot && node src/index.mjs >> bot.log 2>&1
```

## Test

```bash
npm test   # node --test: engine, commands, telegram transport,
           # price fallbacks, publish (local git), e2e (mock Telegram)
```

## Files

- `src/index.mjs` — entry: poll loop + Telegram long-poll loop.
- `src/prices.mjs` — price fetching with fallbacks.
- `src/engine.mjs` — pure alert engine (2-poll fire, cooldown, re-arm).
- `src/state.mjs` — durable `state.json` load/save + public shape.
- `src/publish.mjs` — publish to the `gh-pages` worktree (commit+push).
- `src/commands.mjs` — Telegram command handling (pure over state).
- `src/telegram.mjs` — Bot API transport (getUpdates/sendMessage).
