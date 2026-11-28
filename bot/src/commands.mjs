// Glancefolio bot — Telegram command handling (pure over the bot state).
//
// Commands (DESIGN.md §4): /price, /alert, /alerts, /portfolio, /add,
// /remove, /delalert, /start, /help. No network here — the caller supplies
// the current prices and persists the state when `changed` is true.
// Text replies are plain text (no parse mode) so `$`, `>` etc. need no
// escaping. Glyphs match the glasses app: ● ○ ✓ ▲ ▼.

const DECIMALS = { BTC: 0, ETH: 2, SOL: 2 }
const COINS = ['BTC', 'ETH', 'SOL']

export function fmtPrice(symbol, price) {
  const d = DECIMALS[symbol] ?? 2
  return price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function fmtMoney(value) {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function fmtChange(change) {
  if (change === null || change === undefined || !Number.isFinite(change)) return '—'
  return `${change >= 0 ? '▲' : '▼'}${Math.abs(change).toFixed(1)}%`
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
}

export function parseCommand(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [raw, ...args] = trimmed.slice(1).split(/\s+/)
  const cmd = raw.split('@')[0].toLowerCase()
  return { cmd, args }
}

export const HELP_TEXT = [
  'Glancefolio — portfolio + alerts on your G2 glasses.',
  '',
  '/price [BTC|ETH|SOL] — live price + 24h change',
  '/alert BTC above 70000 — arm a threshold alert',
  '/alerts — list alerts (● armed, ○ off, ✓ fired)',
  '/delalert BTC below 60000 — remove an alert',
  '/portfolio — holdings, total value, P&L',
  '/add BTC 0.42 60000 — add/update a holding (cost basis optional)',
  '/remove SOL — remove a holding',
  '',
  'When a level crosses, I send 🔔 here — and the glasses show it FIRED.',
].join('\n')

function alertLine(a) {
  const dir = a.direction === 'above' ? '>' : '<'
  if (a.firedAt !== null) return `✓ ${a.symbol} ${dir} $${fmtPrice(a.symbol, a.price)} ${fmtTime(a.firedAt)}`
  return `${a.armed ? '●' : '○'} ${a.symbol} ${dir} $${fmtPrice(a.symbol, a.price)}`
}

function sortAlerts(alerts) {
  const order = { BTC: 0, ETH: 1, SOL: 2 }
  return [...alerts].sort((a, b) => {
    const byCoin = (order[a.symbol] ?? 99) - (order[b.symbol] ?? 99)
    if (byCoin !== 0) return byCoin
    if (a.direction === b.direction) return 0
    return a.direction === 'above' ? -1 : 1
  })
}

function portfolioText(state, prices) {
  const { holdings } = state
  if (holdings.length === 0) return 'No holdings yet — /add BTC 0.42 60000'
  let total = 0
  let cost = 0
  let pnlKnown = true
  const lines = []
  for (const h of holdings) {
    const q = prices[h.symbol]
    const value = q ? q.price * h.amount : null
    if (value === null) {
      lines.push(`${h.symbol} ${h.amount} — price unknown`)
      continue
    }
    total += value
    if (h.costBasis === null) pnlKnown = false
    else cost += h.costBasis * h.amount
    lines.push(`${h.symbol} ${h.amount} = ${fmtMoney(value)}`)
  }
  lines.unshift(`Total ${fmtMoney(total)}`)
  if (pnlKnown && cost > 0) {
    const pnl = total - cost
    const pct = (pnl / cost) * 100
    const sign = pnl >= 0 ? '+' : ''
    lines.push(`P&L ${sign}${fmtMoney(pnl)} (${sign}${pct.toFixed(1)}%)`)
  } else {
    lines.push('P&L — (set cost basis)')
  }
  return lines.join('\n')
}

/**
 * Execute one command. `ctx` = { state, prices, priceSource, now }.
 * Mutates ctx.state in place when the command changes it.
 * Returns { reply, changed } — reply is null when the text is not a command.
 */
export function executeCommand(text, ctx) {
  const parsed = parseCommand(text)
  if (!parsed) return { reply: null, changed: false }
  const { cmd, args } = parsed
  const { state, prices } = ctx

  if (cmd === 'start' || cmd === 'help') {
    return { reply: HELP_TEXT, changed: false }
  }

  if (cmd === 'price') {
    const wanted = args[0]?.toUpperCase()
    const symbols = wanted ? [wanted] : COINS
    if (wanted && !COINS.includes(wanted)) {
      return { reply: `Unknown coin ${wanted} — try BTC, ETH or SOL.`, changed: false }
    }
    const lines = symbols.map(sym => {
      const q = prices[sym]
      if (!q) return `${sym} — price unknown`
      return `${sym} $${fmtPrice(sym, q.price)} ${fmtChange(q.change24h)}`
    })
    lines.push(`src: ${ctx.priceSource} · ${fmtTime(Date.now())}`)
    return { reply: lines.join('\n'), changed: false }
  }

  if (cmd === 'alerts') {
    if (state.alerts.length === 0) return { reply: 'No alerts yet — /alert BTC above 70000', changed: false }
    const lines = sortAlerts(state.alerts).map(alertLine)
    lines.unshift(`ALERTS · ${state.alerts.filter(a => a.armed && a.firedAt === null).length} armed`)
    return { reply: lines.join('\n'), changed: false }
  }

  if (cmd === 'alert') {
    const [symRaw, dirRaw, priceRaw] = args
    const symbol = symRaw?.toUpperCase()
    const direction = dirRaw?.toLowerCase()
    const price = Number(priceRaw)
    if (!COINS.includes(symbol) || (direction !== 'above' && direction !== 'below') || !Number.isFinite(price) || price <= 0) {
      return { reply: 'Usage: /alert BTC above 70000', changed: false }
    }
    const id = `${symbol}-${direction}`
    const existing = state.alerts.find(a => a.id === id)
    if (existing) {
      existing.price = price
      existing.armed = true
      existing.firedAt = null
    } else {
      state.alerts.push({ id, symbol, direction, price, armed: true, firedAt: null })
    }
    // Reset the engine runtime for this alert (fresh 2-poll count).
    if (state.runtime) delete state.runtime[id]
    return { reply: `Armed: ${alertLine(state.alerts.find(a => a.id === id))}`, changed: true }
  }

  if (cmd === 'delalert') {
    const [symRaw, dirRaw] = args
    const symbol = symRaw?.toUpperCase()
    const direction = dirRaw?.toLowerCase()
    const id = `${symbol}-${direction}`
    const before = state.alerts.length
    state.alerts = state.alerts.filter(a => a.id !== id)
    if (state.alerts.length === before) return { reply: `No such alert: ${id}`, changed: false }
    if (state.runtime) delete state.runtime[id]
    return { reply: `Removed alert ${id}.`, changed: true }
  }

  if (cmd === 'portfolio') {
    return { reply: portfolioText(state, prices), changed: false }
  }

  if (cmd === 'add') {
    const [symRaw, amountRaw, costRaw] = args
    const symbol = symRaw?.toUpperCase()
    const amount = Number(amountRaw)
    const costBasis = costRaw === undefined ? null : Number(costRaw)
    if (
      !COINS.includes(symbol) ||
      !Number.isFinite(amount) || amount <= 0 ||
      (costRaw !== undefined && (!Number.isFinite(costBasis) || costBasis <= 0))
    ) {
      return { reply: 'Usage: /add BTC 0.42 60000 (cost basis optional)', changed: false }
    }
    const i = state.holdings.findIndex(h => h.symbol === symbol)
    const holding = { symbol, amount, costBasis }
    if (i >= 0) state.holdings[i] = holding
    else state.holdings.push(holding)
    return { reply: `Holding: ${symbol} ${amount}${costBasis !== null ? ` @ $${fmtPrice(symbol, costBasis)}` : ''}`, changed: true }
  }

  if (cmd === 'remove') {
    const symbol = args[0]?.toUpperCase()
    const before = state.holdings.length
    state.holdings = state.holdings.filter(h => h.symbol !== symbol)
    if (state.holdings.length === before) return { reply: `No holding ${symbol}.`, changed: false }
    return { reply: `Removed ${symbol}.`, changed: true }
  }

  return { reply: `Unknown command /${cmd} — /help lists what I do.`, changed: false }
}
