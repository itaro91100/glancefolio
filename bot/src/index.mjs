// Glancefolio bot — entry point (Node, zero dependencies).
//
// Two loops, both best-effort and independent:
//   1. Price poll (every 60 s): CoinGecko -> Binance Vision -> Kraken,
//      alert engine (2 consecutive polls beyond a level, 15-min cooldown,
//      1% re-arm), save state.json, publish to GitHub Pages when the alert
//      state changed (or every 15-min heartbeat with fresh prices), send
//      Telegram 🔔 to every known chat when a level fires.
//   2. Telegram long-poll (only with GLANCEFOLIO_BOT_TOKEN): /price,
//      /alert, /alerts, /portfolio, /add, /remove, /delalert, /help.
//      Without a token the bot still polls + publishes; Telegram is disabled.
//
// Env: GLANCEFOLIO_BOT_TOKEN, GLANCEFOLIO_CHAT_ID (optional allowlist,
//   comma-separated), TELEGRAM_API_BASE (default https://api.telegram.org),
//   BOT_STATE_PATH, BOT_PAGES_DIR, BOT_POLL_SECONDS (default 60),
//   BOT_HEARTBEAT_SECONDS (default 900).
//
// The token is NEVER hardcoded and NEVER logged. Keepalive: bot/keepalive.sh.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fetchPrices } from './prices.mjs'
import { evaluateAlerts } from './engine.mjs'
import { loadState, saveState, publicState } from './state.mjs'
import { publishState } from './publish.mjs'
import { executeCommand } from './commands.mjs'
import { runLongPoll, sendMessage, TelegramError } from './telegram.mjs'

const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CONFIG = {
  // Token: GLANCEFOLIO_BOT_TOKEN preferred, TELEGRAM_BOT_TOKEN accepted
  // (that is the key in bot/.env, written by the parent). Never hardcode.
  token: process.env.GLANCEFOLIO_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
  apiBase: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
  chatAllowlist: (process.env.GLANCEFOLIO_CHAT_ID ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isInteger(n)),
  statePath: process.env.BOT_STATE_PATH ?? resolve(BOT_DIR, 'state.json'),
  pagesDir: process.env.BOT_PAGES_DIR ?? resolve(BOT_DIR, 'pages'),
  pollSeconds: Math.max(15, Number(process.env.BOT_POLL_SECONDS ?? 60) || 60),
  heartbeatSeconds: Math.max(60, Number(process.env.BOT_HEARTBEAT_SECONDS ?? 900) || 900),
}

const HEARTBEAT_MS = CONFIG.heartbeatSeconds * 1000

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function fmtPriceUsd(symbol, price) {
  const d = symbol === 'BTC' ? 0 : 2
  return price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

let stopping = false
let state = await loadState(CONFIG.statePath)
let lastPublishAt = 0
let stateDirty = false

async function publishIfDue(force = false) {
  const now = Date.now()
  if (!force && !stateDirty && now - lastPublishAt < HEARTBEAT_MS) return
  const doc = publicState({ ...state, updatedAt: now })
  const res = await publishState(CONFIG.pagesDir, doc)
  if (res.changed) {
    lastPublishAt = now
    stateDirty = false
    log(`published state to Pages (pushed=${res.pushed})`)
  } else if (res.error) {
    log('publish error (will retry):', res.error)
  } else {
    lastPublishAt = now
    stateDirty = false
  }
}

async function notifyFired(fired) {
  if (fired.length === 0 || state.chatIds.length === 0) return
  if (!CONFIG.token) return
  for (const alert of fired) {
    const dir = alert.direction === 'above' ? 'above' : 'below'
    const text =
      `🔔 ${alert.symbol} — price ${dir} $${fmtPriceUsd(alert.symbol, alert.price)} ` +
      `(now $${fmtPriceUsd(alert.symbol, alert.firedPrice)})`
    for (const chatId of state.chatIds) {
      try {
        await sendMessage({ apiBase: CONFIG.apiBase, token: CONFIG.token, chatId, text })
        log(`notified chat ${chatId}: ${text}`)
      } catch (err) {
        log(`notify chat ${chatId} failed:`, err.message)
      }
    }
  }
}

async function pollOnce() {
  const now = Date.now()
  try {
    const { prices, source } = await fetchPrices()
    state.prices = prices
    state.priceSource = source
    const res = evaluateAlerts({ alerts: state.alerts, prices, runtime: state.runtime, now })
    state.alerts = res.alerts
    state.runtime = res.runtime
    if (res.fired.length > 0) {
      stateDirty = true
      for (const a of res.fired) {
        log(`FIRED ${a.symbol} ${a.direction} $${fmtPriceUsd(a.symbol, a.price)} at $${fmtPriceUsd(a.symbol, a.firedPrice)}`)
      }
      await notifyFired(res.fired)
    }
    if (res.rearmed.length > 0) {
      stateDirty = true
      for (const a of res.rearmed) log(`re-armed ${a.symbol} ${a.direction} $${fmtPriceUsd(a.symbol, a.price)}`)
    }
    await saveState(CONFIG.statePath, state)
    await publishIfDue()
    const summary = Object.entries(prices)
      .map(([s, q]) => `${s} $${fmtPriceUsd(s, q.price)}`)
      .join(' · ')
    log(`poll ok (${source}): ${summary}`)
  } catch (err) {
    log('poll failed:', err.message)
    try {
      await saveState(CONFIG.statePath, state)
    } catch {
      // State save failing is fatal-ish, but the loop must not die.
    }
  }
}

async function pollLoop() {
  while (!stopping) {
    await pollOnce()
    const deadline = Date.now() + CONFIG.pollSeconds * 1000
    while (!stopping && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(1000, deadline - Date.now())))
    }
  }
}

function rememberChat(chatId) {
  if (state.chatIds.includes(chatId)) return false
  state.chatIds.push(chatId)
  if (state.chatIds.length > 10) state.chatIds = state.chatIds.slice(-10)
  stateDirty = true
  return true
}

async function handleTelegramUpdate(update) {
  const message = update.message
  if (!message?.text || typeof message.chat?.id !== 'number') return
  const chatId = message.chat.id
  if (CONFIG.chatAllowlist.length > 0 && !CONFIG.chatAllowlist.includes(chatId)) {
    log(`ignored update from non-allowlisted chat ${chatId}`)
    return
  }
  const newChat = rememberChat(chatId)
  // A command asked before the first poll finished (or after a long
  // outage) still deserves live data — fetch once on demand.
  if (Object.keys(state.prices).length === 0) {
    try {
      const { prices, source } = await fetchPrices()
      state.prices = prices
      state.priceSource = source
      await saveState(CONFIG.statePath, state)
    } catch (err) {
      log('on-demand price fetch failed:', err.message)
    }
  }
  const { reply, changed } = executeCommand(message.text, {
    state,
    prices: state.prices,
    priceSource: state.priceSource,
    now: Date.now(),
  })
  if (reply !== null) {
    try {
      await sendMessage({ apiBase: CONFIG.apiBase, token: CONFIG.token, chatId, text: reply })
    } catch (err) {
      log(`reply to ${chatId} failed:`, err.message)
    }
  }
  if (changed || newChat) {
    stateDirty = true
    await saveState(CONFIG.statePath, state)
    if (changed) await publishIfDue(true)
  }
}

async function telegramLoop() {
  if (!CONFIG.token) {
    log('Telegram disabled: no bot token set (GLANCEFOLIO_BOT_TOKEN or TELEGRAM_BOT_TOKEN) — poll + publish still run')
    return
  }
  log('Telegram long-poll starting')
  const res = await runLongPoll({
    apiBase: CONFIG.apiBase,
    token: CONFIG.token,
    onUpdate: handleTelegramUpdate,
    shouldStop: () => stopping,
    onError: err => {
      if (err instanceof TelegramError && err.status === 401) {
        log('Telegram token rejected (401) — check GLANCEFOLIO_BOT_TOKEN; Telegram disabled')
      } else {
        log('Telegram poll error (retrying):', err.message)
      }
    },
  })
  if (res.authError) log('Telegram long-poll stopped: invalid token')
}

async function main() {
  log(`Glancefolio bot starting (poll ${CONFIG.pollSeconds}s, heartbeat ${CONFIG.heartbeatSeconds}s)`)
  log(`state: ${CONFIG.statePath}`)
  log(`pages: ${CONFIG.pagesDir}`)
  process.on('SIGINT', () => {
    stopping = true
    log('SIGINT — stopping')
  })
  process.on('SIGTERM', () => {
    stopping = true
    log('SIGTERM — stopping')
  })
  // Publish the current state once at startup so Pages is never stale.
  stateDirty = true
  await publishIfDue(true)
  await Promise.all([pollLoop(), telegramLoop()])
  await saveState(CONFIG.statePath, state)
  log('Glancefolio bot stopped')
}

await main()
