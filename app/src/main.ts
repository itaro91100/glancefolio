// Glancefolio — Day 3, build week (25 Nov 2026).
//
// Three screens, one multi-line text container (576x288, ~10 lines of 27 px),
// cursor-first navigation (DESIGN.md §2, §8 Day 2):
//
//   Screen 1 Portfolio — live BTC/ETH/SOL prices + total + P&L. Cursor rows
//     are the holdings plus an `ALERTS ▸` nav row at the bottom. Tap opens
//     the detail screen (holding) or the alerts screen (ALERTS row).
//   Screen 2 Alerts — armed/disarmed/fired alerts, one per row. Tap toggles
//     arm/disarm (a fired alert re-arms). Double-tap goes back to Screen 1.
//   Screen 3 Coin detail — price, 24h change + high/low (when the Binance
//     source supplied them), holding value, position P&L, alert state for the
//     coin. Tap cycles the alert: off → above → below → off (levels ±5%,
//     rounded to 3 significant figures). Double-tap goes back to Screen 1.
//
// Day 3 adds the bot sync: the Telegram bot publishes its alert state as
// state/alerts.json on GitHub Pages, and the glasses fetch it (when online)
// and merge FIRED state into the local alerts — a fired alert shows `FIRED` +
// time on Screen 2 (a plain word, never a glyph: `✓` does not render in the
// simulator font, verified Day 3). The bot is the writer of fired state, the glasses are
// the reader; arming stays local (glasses/companion). If the Pages fetch
// fails (offline), the glasses keep working on local state alone.
//
// Double-tap on Screen 1 exits (root, debounced ~1.2 s). There is no
// horizontal swipe in the SDK event set, so screens change only via tap on a
// nav row / double-tap back. Tap-to-refresh from Day 1 is gone — prices
// refresh on the 60 s poll and on foreground-enter.
//
// Data: CoinGecko (primary) -> Binance Vision -> Kraken (fallbacks), 60 s
// poll. Holdings + alerts live in localStorage (schema glancefolio:v1:*,
// shared store module) and are edited on the companion page (companion.ts)
// or, from Day 3, via the Telegram bot. No wallet, no keys, no trading —
// read-only.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import {
  ALERTS_CHANGED_EVENT,
  HOLDINGS_CHANGED_EVENT,
  alertId,
  alertsForSymbol,
  loadAlerts,
  loadHoldings,
  loadSettings,
  removeAlert,
  saveAlerts,
  sortAlerts,
  upsertAlert,
  type Alert,
  type CoinSymbol,
  type Holding,
} from './store'
import { mountCompanion } from './companion'

const BUILD_STAMP = 'b4'
const FETCH_TIMEOUT_MS = 10_000
const MAX_SEND_FAILURES = 3
const DOUBLE_TAP_DEBOUNCE_MS = 1_200
const BOT_STATE_URL = 'https://itaro91100.github.io/glancefolio/state/alerts.json'
const BOT_SYNC_MIN_GAP_MS = 60_000

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

type Coin = {
  symbol: CoinSymbol
  geckoId: string
  binance: string
  kraken: string
  decimals: number
}

const COINS: Coin[] = [
  { symbol: 'BTC', geckoId: 'bitcoin', binance: 'BTCUSDT', kraken: 'XBTUSD', decimals: 0 },
  { symbol: 'ETH', geckoId: 'ethereum', binance: 'ETHUSDT', kraken: 'ETHUSD', decimals: 2 },
  { symbol: 'SOL', geckoId: 'solana', binance: 'SOLUSDT', kraken: 'SOLUSD', decimals: 2 },
]

const POLL_MS = loadSettings(localStorage).pollSeconds * 1000

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

type Quote = { price: number; change24h: number | null; high24h: number | null; low24h: number | null }
type PriceMap = Record<string, Quote>
type PriceSource = 'CG' | 'BIN' | 'KRAK'

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

async function fetchFromCoinGecko(): Promise<PriceMap> {
  const ids = COINS.map(c => c.geckoId).join(',')
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    `&vs_currencies=usd&include_24hr_change=true`
  const data = (await fetchJson(url)) as Record<string, { usd: number; usd_24h_change: number }>
  const out: PriceMap = {}
  for (const coin of COINS) {
    const row = data[coin.geckoId]
    if (!row || typeof row.usd !== 'number') throw new Error(`no ${coin.symbol} in CoinGecko reply`)
    // simple/price has no 24h high/low — those come from Binance when it is
    // the active source (see fetchFromBinanceVision).
    out[coin.symbol] = { price: row.usd, change24h: row.usd_24h_change ?? null, high24h: null, low24h: null }
  }
  return out
}

async function fetchFromBinanceVision(): Promise<PriceMap> {
  const rows = await Promise.all(
    COINS.map(async coin => {
      const data = (await fetchJson(
        `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${coin.binance}`,
      )) as {
        lastPrice: string
        priceChangePercent: string
        highPrice: string
        lowPrice: string
      }
      return {
        coin,
        price: Number(data.lastPrice),
        change: Number(data.priceChangePercent),
        high: Number(data.highPrice),
        low: Number(data.lowPrice),
      }
    }),
  )
  const out: PriceMap = {}
  for (const { coin, price, change, high, low } of rows) {
    if (!Number.isFinite(price)) throw new Error(`no ${coin.symbol} in Binance reply`)
    out[coin.symbol] = {
      price,
      change24h: Number.isFinite(change) ? change : null,
      high24h: Number.isFinite(high) ? high : null,
      low24h: Number.isFinite(low) ? low : null,
    }
  }
  return out
}

async function fetchFromKraken(): Promise<PriceMap> {
  const pairs = COINS.map(c => c.kraken).join(',')
  const data = (await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`)) as {
    error: string[]
    result: Record<string, { c: [string, string] }>
  }
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join('; ')}`)
  const out: PriceMap = {}
  for (const coin of COINS) {
    const row = data.result[coin.kraken]
    const price = row ? Number(row.c?.[0]) : NaN
    if (!Number.isFinite(price)) throw new Error(`no ${coin.symbol} in Kraken reply`)
    out[coin.symbol] = { price, change24h: null, high24h: null, low24h: null }
  }
  return out
}

async function fetchPrices(): Promise<{ prices: PriceMap; source: PriceSource }> {
  try {
    return { prices: await fetchFromCoinGecko(), source: 'CG' }
  } catch (e1) {
    console.log('CoinGecko failed, trying Binance Vision:', e1)
    try {
      return { prices: await fetchFromBinanceVision(), source: 'BIN' }
    } catch (e2) {
      console.log('Binance Vision failed, trying Kraken:', e2)
      return { prices: await fetchFromKraken(), source: 'KRAK' }
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtPrice(symbol: string, price: number): string {
  const coin = COINS.find(c => c.symbol === symbol) ?? COINS[0]
  return price.toLocaleString('en-US', {
    minimumFractionDigits: coin.decimals,
    maximumFractionDigits: coin.decimals,
  })
}

function fmtMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function fmtCompact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function fmtChange(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '—'
  const arrow = change >= 0 ? '▲' : '▼'
  return `${arrow}${Math.abs(change).toFixed(1)}%`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

// ---------------------------------------------------------------------------
// Alert levels: ±5% of the current price, rounded to 3 significant figures
// (BTC 61,253 → above 64,300 / below 58,100; ETH 1,720 → 1,810 / 1,630;
// SOL 72.16 → 75.80 / 68.60).
// ---------------------------------------------------------------------------

function roundSig(x: number, sig = 3): number {
  if (x <= 0 || !Number.isFinite(x)) return 0
  const p = Math.pow(10, Math.ceil(Math.log10(x)) - sig)
  return Math.round(x / p) * p
}

function levelAbove(price: number): number {
  return roundSig(price * 1.05)
}

function levelBelow(price: number): number {
  return roundSig(price * 0.95)
}

// ---------------------------------------------------------------------------
// State + rendering (single-column, cursor-first)
// ---------------------------------------------------------------------------

type FetchStatus = 'LIVE' | 'STALE' | 'ERR'
type Screen = 1 | 2 | 3

let holdings: Holding[] = loadHoldings(localStorage)
let alerts: Alert[] = loadAlerts(localStorage)
let prices: PriceMap = {}
let priceSource: PriceSource = 'CG'
let lastFetchAt = 0
let fetchStatus: FetchStatus = 'ERR'
let lastError = ''
let screen: Screen = 1
let cursor1 = 0 // Screen 1: index into holdings rows + the ALERTS nav row
let cursor2 = 0 // Screen 2: index into the sorted alert rows
let detailSymbol: CoinSymbol = 'BTC' // Screen 3: which coin the detail shows
let sendFailures = 0
let lastDoubleTapAt = 0
let lastBotSyncAt = 0
let botSyncOk = false

// Cursor window (DESIGN.md §2): the active row is always visible; the list
// scrolls only when the cursor leaves the window.
function windowStart(cursor: number, total: number, visible: number): number {
  const maxStart = Math.max(0, total - visible)
  return Math.min(Math.max(0, cursor - visible + 1), maxStart)
}

const VISIBLE_HOLDINGS = 3
const VISIBLE_ALERTS = 5

/** Screen 1 cursorable rows: one per holding, plus the ALERTS nav row. */
function rows1Count(): number {
  return holdings.length + 1
}

/** Alerts in display order: coin order, 'above' before 'below'. */
function sortedAlerts(): Alert[] {
  return sortAlerts(alerts)
}

function portfolioTotals(): {
  total: number
  change24h: number | null
  pnl: number | null
  pnlPct: number | null
} {
  let total = 0
  let weightedChange = 0
  let changeWeight = 0
  let cost = 0
  let pnlKnown = true
  for (const h of holdings) {
    const q = prices[h.symbol]
    if (!q) continue
    const value = q.price * h.amount
    total += value
    if (q.change24h !== null) {
      weightedChange += value * q.change24h
      changeWeight += value
    }
    if (h.costBasis === null) {
      pnlKnown = false
    } else {
      cost += h.costBasis * h.amount
    }
  }
  const pnl = pnlKnown ? total - cost : null
  return {
    total,
    change24h: changeWeight > 0 ? weightedChange / changeWeight : null,
    pnl,
    pnlPct: pnl !== null && cost > 0 ? (pnl / cost) * 100 : null,
  }
}

function alertSummaryLine(): string {
  const armed = alerts.filter(a => a.armed && a.firedAt === null).length
  const fired = alerts.filter(a => a.firedAt !== null).length
  return `ALERTS ${armed} armed · ${fired} fired`
}

function renderScreen1(): string {
  const { total, change24h, pnl, pnlPct } = portfolioTotals()
  const lines: string[] = []
  lines.push(`GLANCEFOLIO · ${BUILD_STAMP}`)
  lines.push(
    total > 0
      ? `Total ${fmtMoney(total)}  ${fmtChange(change24h)}`
      : 'Total —  (no holdings)',
  )
  if (pnl !== null && pnlPct !== null) {
    const sign = pnl >= 0 ? '+' : ''
    lines.push(`P&L ${sign}${fmtMoney(pnl)} (${sign}${pnlPct.toFixed(1)}%)`)
  } else {
    lines.push('P&L —  (set cost basis)')
  }
  lines.push('')
  const rows = rows1Count()
  const start = windowStart(cursor1, rows, VISIBLE_HOLDINGS)
  for (let i = start; i < Math.min(start + VISIBLE_HOLDINGS, rows); i++) {
    const marker = i === cursor1 ? '▶ ' : '  '
    if (i < holdings.length) {
      const h = holdings[i]
      const q = prices[h.symbol]
      const price = q ? fmtPrice(h.symbol, q.price) : '—'
      const change = q ? fmtChange(q.change24h) : '—'
      lines.push(`${marker}${h.symbol} ${price} ${change}`)
    } else {
      lines.push(`${marker}ALERTS ▸`)
    }
  }
  if (cursor1 < holdings.length) {
    const selected = holdings[cursor1]
    const sq = selected ? prices[selected.symbol] : undefined
    lines.push(
      selected && sq
        ? `HOLD ${selected.amount} ${selected.symbol} = ${fmtMoney(sq.price * selected.amount)}`
        : 'HOLD —',
    )
  } else {
    lines.push(alertSummaryLine())
  }
  const statusWord = fetchStatus === 'LIVE' ? 'LIVE' : fetchStatus === 'STALE' ? 'STALE' : 'ERR'
  const statusDetail =
    fetchStatus === 'ERR'
      ? lastError || 'fetch failed'
      : `${fmtTime(lastFetchAt)} · ${priceSource}${botSyncOk ? ' · BOT' : ''}`
  lines.push(`${statusWord} ${statusDetail}`)
  lines.push('tap open · 2×tap exit')
  return lines.join('\n')
}

function alertRowText(a: Alert): string {
  const dir = a.direction === 'above' ? '>' : '<'
  const level = fmtPrice(a.symbol, a.price)
  if (a.firedAt !== null) return `FIRED ${a.symbol} ${dir} $${level} ${fmtTime(a.firedAt)}`
  const dot = a.armed ? '●' : '○'
  return `${dot} ${a.symbol} ${dir} $${level}`
}

function renderScreen2(): string {
  const lines: string[] = []
  const rows = sortedAlerts()
  const armed = alerts.filter(a => a.armed && a.firedAt === null).length
  const fired = alerts.filter(a => a.firedAt !== null).length
  lines.push(`ALERTS · ${armed} armed${fired > 0 ? ` · ${fired} fired` : ''}`)
  if (rows.length === 0) {
    lines.push('')
    lines.push('No alerts yet')
    lines.push('tap a coin to set one')
  } else {
    const start = windowStart(cursor2, rows.length, VISIBLE_ALERTS)
    for (let i = start; i < Math.min(start + VISIBLE_ALERTS, rows.length); i++) {
      const marker = i === cursor2 ? '▶ ' : '  '
      lines.push(`${marker}${alertRowText(rows[i])}`)
    }
  }
  lines.push('tap: arm/disarm · 2×tap: back')
  return lines.join('\n')
}

function renderScreen3(): string {
  const holding = holdings.find(h => h.symbol === detailSymbol)
  const q = prices[detailSymbol]
  const lines: string[] = []
  lines.push(`${detailSymbol} ${q ? fmtPrice(detailSymbol, q.price) : '—'}`)
  if (q) {
    const range =
      q.high24h !== null && q.low24h !== null
        ? ` · Hi ${fmtCompact(q.high24h)} Lo ${fmtCompact(q.low24h)}`
        : ''
    lines.push(`24h ${fmtChange(q.change24h)}${range}`)
  } else {
    lines.push('24h —')
  }
  if (holding && q) {
    lines.push(`Hold ${holding.amount} · ${fmtMoney(q.price * holding.amount)}`)
    if (holding.costBasis !== null) {
      const pnl = (q.price - holding.costBasis) * holding.amount
      const cost = holding.costBasis * holding.amount
      const pct = cost > 0 ? (pnl / cost) * 100 : 0
      const sign = pnl >= 0 ? '+' : ''
      lines.push(`P&L ${sign}${fmtMoney(pnl)} (${sign}${pct.toFixed(1)}%)`)
    } else {
      lines.push('P&L — (no cost basis)')
    }
  } else {
    lines.push('Hold —')
    lines.push('P&L —')
  }
  const mine = alertsForSymbol(alerts, detailSymbol)
  if (mine.length === 0) {
    lines.push('Alert off')
  } else {
    for (const a of mine) {
      const dir = a.direction === 'above' ? '>' : '<'
      const dot = a.firedAt !== null ? 'FIRED' : a.armed ? '●' : '○'
      lines.push(`Alert ${dir} $${fmtPrice(detailSymbol, a.price)} ${dot}`)
    }
  }
  lines.push('tap: alert · 2×tap: back')
  return lines.join('\n')
}

function renderScreen(): string {
  if (screen === 3 && !holdings.some(h => h.symbol === detailSymbol)) {
    // The detail coin was deleted on the companion page — fall back home.
    screen = 1
  }
  if (screen === 2) return renderScreen2()
  if (screen === 3) return renderScreen3()
  return renderScreen1()
}

// ---------------------------------------------------------------------------
// Alert actions
// ---------------------------------------------------------------------------

function notifyAlertsChanged(): void {
  window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT))
}

/** Screen 3 tap: cycle the coin's alert off → above → below → off. */
function cycleAlert(symbol: CoinSymbol): void {
  const q = prices[symbol]
  if (!q) return // no price yet — cannot compute a level
  const existing = alertsForSymbol(alerts, symbol)
  if (existing.length === 0) {
    alerts = upsertAlert(alerts, {
      id: alertId(symbol, 'above'),
      symbol,
      direction: 'above',
      price: levelAbove(q.price),
      armed: true,
      firedAt: null,
    })
  } else if (existing.length === 1 && existing[0].direction === 'above') {
    alerts = removeAlert(alerts, existing[0].id)
    alerts = upsertAlert(alerts, {
      id: alertId(symbol, 'below'),
      symbol,
      direction: 'below',
      price: levelBelow(q.price),
      armed: true,
      firedAt: null,
    })
  } else {
    alerts = alerts.filter(a => a.symbol !== symbol)
  }
  saveAlerts(localStorage, alerts)
  notifyAlertsChanged()
  render()
}

/** Screen 2 tap: toggle arm/disarm; a fired alert re-arms. */
function toggleAlertAt(index: number): void {
  const rows = sortedAlerts()
  const row = rows[index]
  if (!row) return
  const current = alerts.find(a => a.id === row.id)
  if (!current) return
  if (current.firedAt !== null) {
    current.firedAt = null
    current.armed = true
  } else {
    current.armed = !current.armed
  }
  alerts = upsertAlert(alerts, current)
  saveAlerts(localStorage, alerts)
  notifyAlertsChanged()
  render()
}

// ---------------------------------------------------------------------------
// Bridge setup
// ---------------------------------------------------------------------------

const bridge = await waitForEvenAppBridge()

const capture = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 0,
  containerID: 1,
  containerName: 'capture',
  content: ' ',
  isEventCapture: 1,
})

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 2,
  containerName: 'main',
  content: renderScreen(),
})

// Serialize ALL bridge writes through ONE promise chain; drop-not-queue.
let writeChain: Promise<void> = Promise.resolve()

function pushContent(content: string): void {
  writeChain = writeChain
    .then(async () => {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 2, containerName: 'main', content }),
      )
      sendFailures = 0
    })
    .catch(err => {
      sendFailures += 1
      console.log(`text upgrade failed (${sendFailures}/${MAX_SEND_FAILURES}):`, err)
      if (sendFailures >= MAX_SEND_FAILURES) void recreatePage()
    })
}

async function createPage(): Promise<void> {
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [capture, mainText] }),
  )
  console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)
}

async function recreatePage(): Promise<void> {
  sendFailures = 0
  mainText.content = renderScreen()
  await createPage()
}

function render(): void {
  pushContent(renderScreen())
}

function reloadStore(): void {
  holdings = loadHoldings(localStorage)
  alerts = loadAlerts(localStorage)
  cursor1 = Math.min(Math.max(0, cursor1), Math.max(0, rows1Count() - 1))
  cursor2 = Math.min(Math.max(0, cursor2), Math.max(0, sortedAlerts().length - 1))
}

async function refreshPrices(): Promise<void> {
  try {
    const { prices: next, source } = await fetchPrices()
    prices = next
    priceSource = source
    lastFetchAt = Date.now()
    fetchStatus = 'LIVE'
    lastError = ''
  } catch (err) {
    // Keep the last good prices on screen, mark the row STALE/ERR.
    fetchStatus = Object.keys(prices).length > 0 ? 'STALE' : 'ERR'
    lastError = err instanceof Error ? err.message.slice(0, 40) : 'fetch failed'
    console.log('price fetch failed:', err)
  }
  render()
  // Fire-and-forget: the bot sync re-renders by itself when it changes
  // anything, so a slow Pages fetch never delays the price render.
  void syncBotState()
}

// ---------------------------------------------------------------------------
// Bot state sync (Day 3): the Telegram bot publishes its alert state to
// GitHub Pages; the glasses merge FIRED state into the local alerts.
// Merge rule — the bot is the writer of fired state, the glasses the reader:
//   * bot firedAt set + local firedAt null  -> take the bot's firedAt
//     (the FIRED row appears on Screen 2).
//   * bot firedAt null + local firedAt set + bot doc newer than the local
//     fire -> the bot re-armed it, clear the local firedAt.
// Arming stays local (glasses/companion/bot commands each own their copy);
// bot-only alerts (no local row) are not shown. A failed fetch is normal
// offline behaviour — the glasses keep working on local state.
// ---------------------------------------------------------------------------

type BotStateDoc = {
  updatedAt: number
  alerts: Array<{
    id: string
    symbol: CoinSymbol
    direction: 'above' | 'below'
    price: number
    armed: boolean
    firedAt: number | null
  }>
}

async function syncBotState(): Promise<void> {
  const now = Date.now()
  if (now - lastBotSyncAt < BOT_SYNC_MIN_GAP_MS) return
  lastBotSyncAt = now
  try {
    const doc = (await fetchJson(BOT_STATE_URL)) as BotStateDoc
    if (!doc || !Array.isArray(doc.alerts)) return
    botSyncOk = true
    let changed = false
    for (const ba of doc.alerts) {
      const local = alerts.find(a => a.id === ba.id)
      if (!local) continue
      if (ba.firedAt !== null && local.firedAt === null) {
        local.firedAt = ba.firedAt
        changed = true
      } else if (
        ba.firedAt === null &&
        local.firedAt !== null &&
        typeof doc.updatedAt === 'number' &&
        doc.updatedAt > local.firedAt
      ) {
        local.firedAt = null
        changed = true
      }
    }
    if (changed) {
      saveAlerts(localStorage, alerts)
      notifyAlertsChanged()
      render()
    }
  } catch (err) {
    botSyncOk = false
    console.log('bot state sync failed (offline ok):', err)
  }
}

// Companion page edits holdings/alerts in the same document — re-read the
// store and re-render when it tells us.
window.addEventListener(HOLDINGS_CHANGED_EVENT, () => {
  reloadStore()
  render()
})
window.addEventListener(ALERTS_CHANGED_EVENT, () => {
  reloadStore()
  render()
})

mountCompanion(document, localStorage, name => window.dispatchEvent(new Event(name)))

await createPage()
void refreshPrices()
setInterval(() => void refreshPrices(), POLL_MS)

// The Even app moves the WebView headless when the phone locks — snapshot /
// restore so the screen comes back exactly as it was.
;(window as unknown as Record<string, unknown>).__getStateSnapshot = () =>
  JSON.stringify({
    cursor: cursor1,
    cursor2,
    detailSymbol,
    holdings,
    prices,
    lastFetchAt,
    priceSource,
    screen,
  })
;(window as unknown as Record<string, unknown>).__restoreState = (snap: string) => {
  try {
    const s = JSON.parse(snap) as {
      cursor: number
      cursor2: number
      detailSymbol: CoinSymbol
      prices: PriceMap
      lastFetchAt: number
      screen: Screen
    }
    reloadStore()
    cursor1 = Math.min(Math.max(0, s.cursor | 0), Math.max(0, rows1Count() - 1))
    cursor2 = Math.min(Math.max(0, s.cursor2 | 0), Math.max(0, sortedAlerts().length - 1))
    if (holdings.some(h => h.symbol === s.detailSymbol)) detailSymbol = s.detailSymbol
    if (s.screen === 2 || s.screen === 3) screen = s.screen
    prices = s.prices ?? prices
    lastFetchAt = s.lastFetchAt ?? lastFetchAt
    fetchStatus = 'STALE'
    render()
  } catch (err) {
    console.log('state restore failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// CLICK_EVENT is 0 and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. Resolve
// the default INSIDE the envelope check — never read a default off an event
// that carries no sysEvent/textEvent at all.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // Double-tap: one level up (Screens 2/3 → Screen 1); on Screen 1 it exits
  // (root, debounced ~1.2 s, mode 1 = system exit dialog).
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    const now = Date.now()
    if (now - lastDoubleTapAt < DOUBLE_TAP_DEBOUNCE_MS) return
    lastDoubleTapAt = now
    if (screen !== 1) {
      screen = 1
      render()
    } else {
      bridge.shutDownPageContainer(1)
    }
    return
  }

  // Swipe = SCROLL_TOP / SCROLL_BOTTOM on the text event; move the cursor of
  // the current screen (Screen 3 has no cursor — swipes are ignored there).
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT || sysType === OsEventTypeList.SCROLL_TOP_EVENT) {
    if (screen === 1) cursor1 = Math.max(0, cursor1 - 1)
    if (screen === 2) cursor2 = Math.max(0, cursor2 - 1)
    render()
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT || sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    if (screen === 1) cursor1 = Math.min(rows1Count() - 1, cursor1 + 1)
    if (screen === 2) cursor2 = Math.min(Math.max(0, sortedAlerts().length - 1), cursor2 + 1)
    render()
    return
  }

  // Tap: Screen 1 opens (holding → detail, ALERTS row → alerts screen);
  // Screen 2 toggles arm/disarm; Screen 3 cycles the coin's alert.
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (screen === 1) {
      if (cursor1 < holdings.length) {
        detailSymbol = holdings[cursor1].symbol
        screen = 3
      } else {
        cursor2 = 0
        screen = 2
      }
      render()
    } else if (screen === 2) {
      toggleAlertAt(cursor2)
    } else {
      cycleAlert(detailSymbol)
    }
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    reloadStore()
    void refreshPrices()
    void syncBotState()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    unsubscribe()
  }
})
