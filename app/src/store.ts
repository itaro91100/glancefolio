// Glancefolio shared store — schema `glancefolio:v1:*` (DESIGN.md §13.4).
//
// Pure functions over a Storage-like object, so the same code runs in the
// glasses app (main.ts), the companion page (companion.ts), and Node tests.
// No DOM, no network, no secrets — holdings and alerts are the user's own
// read-only portfolio data; no wallet, no keys, no trading.

export type Holding = { symbol: CoinSymbol; amount: number; costBasis: number | null }
export type AlertDirection = 'above' | 'below'
export type Alert = {
  id: string
  symbol: CoinSymbol
  direction: AlertDirection
  price: number
  armed: boolean
  firedAt: number | null
}
export type Settings = { pollSeconds: number }

export interface StoreLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const COIN_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const
export type CoinSymbol = (typeof COIN_SYMBOLS)[number]

export const HOLDINGS_KEY = 'glancefolio:v1:holdings'
export const ALERTS_KEY = 'glancefolio:v1:alerts'
export const SETTINGS_KEY = 'glancefolio:v1:settings'

export const HOLDINGS_CHANGED_EVENT = 'glancefolio:holdings-changed'
export const ALERTS_CHANGED_EVENT = 'glancefolio:alerts-changed'

// Demo seed, used only when the phone has no data yet. Marked as demo in the
// README; NOT real user data. An explicitly saved empty list stays empty —
// the seed only fires when the key is absent (first run).
export const DEMO_HOLDINGS: Holding[] = [
  { symbol: 'BTC', amount: 0.42, costBasis: 60_000 },
  { symbol: 'ETH', amount: 2.5, costBasis: 1_700 },
  { symbol: 'SOL', amount: 12, costBasis: 68 },
]

export const DEMO_ALERTS: Alert[] = [
  { id: 'BTC-above', symbol: 'BTC', direction: 'above', price: 70_000, armed: true, firedAt: null },
  { id: 'SOL-below', symbol: 'SOL', direction: 'below', price: 70, armed: true, firedAt: null },
]

export function isCoinSymbol(s: string): s is CoinSymbol {
  return (COIN_SYMBOLS as readonly string[]).includes(s)
}

/** Returns an error message, or null when the holding is valid. */
export function validateHolding(
  symbol: string,
  amount: unknown,
  costBasis: unknown,
): string | null {
  if (!isCoinSymbol(symbol)) return 'Unknown coin'
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return 'Amount must be a number > 0'
  }
  if (amount > 1e9) return 'Amount too large'
  if (
    costBasis !== null &&
    costBasis !== undefined &&
    (typeof costBasis !== 'number' || !Number.isFinite(costBasis) || costBasis <= 0)
  ) {
    return 'Cost basis must be a number > 0, or empty'
  }
  return null
}

function isHolding(value: unknown): value is Holding {
  if (typeof value !== 'object' || value === null) return false
  const h = value as Holding
  return (
    isCoinSymbol(h.symbol) &&
    typeof h.amount === 'number' &&
    Number.isFinite(h.amount) &&
    h.amount > 0 &&
    (h.costBasis === null || (typeof h.costBasis === 'number' && Number.isFinite(h.costBasis)))
  )
}

export function loadHoldings(store: StoreLike): Holding[] {
  try {
    const raw = store.getItem(HOLDINGS_KEY)
    if (raw === null) {
      store.setItem(HOLDINGS_KEY, JSON.stringify(DEMO_HOLDINGS))
      return [...DEMO_HOLDINGS]
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('holdings is not an array')
    return parsed.filter(isHolding)
  } catch {
    return [...DEMO_HOLDINGS]
  }
}

export function saveHoldings(store: StoreLike, holdings: Holding[]): void {
  store.setItem(HOLDINGS_KEY, JSON.stringify(holdings))
}

export function upsertHolding(holdings: Holding[], next: Holding): Holding[] {
  const i = holdings.findIndex(h => h.symbol === next.symbol)
  if (i >= 0) {
    const copy = [...holdings]
    copy[i] = next
    return copy
  }
  return [...holdings, next]
}

export function removeHolding(holdings: Holding[], symbol: string): Holding[] {
  return holdings.filter(h => h.symbol !== symbol)
}

export function alertId(symbol: CoinSymbol, direction: AlertDirection): string {
  return `${symbol}-${direction}`
}

function isAlert(value: unknown): value is Alert {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Alert
  return (
    typeof a.id === 'string' &&
    isCoinSymbol(a.symbol) &&
    (a.direction === 'above' || a.direction === 'below') &&
    typeof a.price === 'number' &&
    Number.isFinite(a.price) &&
    a.price > 0 &&
    typeof a.armed === 'boolean' &&
    (a.firedAt === null || typeof a.firedAt === 'number')
  )
}

export function loadAlerts(store: StoreLike): Alert[] {
  try {
    const raw = store.getItem(ALERTS_KEY)
    if (raw === null) {
      store.setItem(ALERTS_KEY, JSON.stringify(DEMO_ALERTS))
      return [...DEMO_ALERTS]
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('alerts is not an array')
    return parsed.filter(isAlert)
  } catch {
    return [...DEMO_ALERTS]
  }
}

export function saveAlerts(store: StoreLike, alerts: Alert[]): void {
  store.setItem(ALERTS_KEY, JSON.stringify(alerts))
}

export function upsertAlert(alerts: Alert[], next: Alert): Alert[] {
  const i = alerts.findIndex(a => a.id === next.id)
  if (i >= 0) {
    const copy = [...alerts]
    copy[i] = next
    return copy
  }
  return [...alerts, next]
}

export function removeAlert(alerts: Alert[], id: string): Alert[] {
  return alerts.filter(a => a.id !== id)
}

/** Alerts for one coin, 'above' first, then 'below'. */
export function alertsForSymbol(alerts: Alert[], symbol: CoinSymbol): Alert[] {
  return sortAlerts(alerts.filter(a => a.symbol === symbol))
}

/** Display order everywhere (glasses + companion): coin order, 'above' first. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  const order: Record<string, number> = { BTC: 0, ETH: 1, SOL: 2 }
  return [...alerts].sort((a, b) => {
    const byCoin = (order[a.symbol] ?? 99) - (order[b.symbol] ?? 99)
    if (byCoin !== 0) return byCoin
    if (a.direction === b.direction) return 0
    return a.direction === 'above' ? -1 : 1
  })
}

export function loadSettings(store: StoreLike): Settings {
  try {
    const raw = store.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      if (
        typeof parsed.pollSeconds === 'number' &&
        parsed.pollSeconds >= 15 &&
        parsed.pollSeconds <= 600
      ) {
        return { pollSeconds: parsed.pollSeconds }
      }
    }
  } catch {
    // Fall through to the default.
  }
  return { pollSeconds: 60 }
}
