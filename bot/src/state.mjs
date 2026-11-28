// Glancefolio bot — durable state (bot/state.json).
//
// One JSON file on the VM: holdings, alerts, per-alert runtime, last
// prices, last chat id (for Telegram 🔔 delivery), updatedAt. The glasses
// app never reads this file directly — it reads the published copy at
// state/alerts.json on GitHub Pages (see publish.mjs).
//
// Demo seed = the same demo holdings/alerts as the glasses app (store.ts).
// Marked as demo in the README; the user replaces them via /add and /alert.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const COIN_SYMBOLS = ['BTC', 'ETH', 'SOL']

export const DEMO_HOLDINGS = [
  { symbol: 'BTC', amount: 0.42, costBasis: 60_000 },
  { symbol: 'ETH', amount: 2.5, costBasis: 1_700 },
  { symbol: 'SOL', amount: 12, costBasis: 68 },
]

export const DEMO_ALERTS = [
  { id: 'BTC-above', symbol: 'BTC', direction: 'above', price: 70_000, armed: true, firedAt: null },
  { id: 'SOL-below', symbol: 'SOL', direction: 'below', price: 70, armed: true, firedAt: null },
]

function isHolding(v) {
  return (
    v && typeof v === 'object' &&
    COIN_SYMBOLS.includes(v.symbol) &&
    typeof v.amount === 'number' && Number.isFinite(v.amount) && v.amount > 0 &&
    (v.costBasis === null || (typeof v.costBasis === 'number' && Number.isFinite(v.costBasis)))
  )
}

function isAlert(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.id === 'string' &&
    COIN_SYMBOLS.includes(v.symbol) &&
    (v.direction === 'above' || v.direction === 'below') &&
    typeof v.price === 'number' && Number.isFinite(v.price) && v.price > 0 &&
    typeof v.armed === 'boolean' &&
    (v.firedAt === null || typeof v.firedAt === 'number')
  )
}

export function freshState(now = Date.now()) {
  return {
    version: 1,
    holdings: DEMO_HOLDINGS.map(h => ({ ...h })),
    alerts: DEMO_ALERTS.map(a => ({ ...a })),
    runtime: {},
    prices: {},
    priceSource: 'none',
    chatIds: [],
    updatedAt: now,
  }
}

export async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('state is not an object')
    return {
      version: 1,
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings.filter(isHolding) : [...DEMO_HOLDINGS],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts.filter(isAlert) : [...DEMO_ALERTS],
      runtime: typeof parsed.runtime === 'object' && parsed.runtime !== null ? parsed.runtime : {},
      prices: typeof parsed.prices === 'object' && parsed.prices !== null ? parsed.prices : {},
      priceSource: typeof parsed.priceSource === 'string' ? parsed.priceSource : 'none',
      chatIds: Array.isArray(parsed.chatIds) ? parsed.chatIds.filter(n => Number.isInteger(n)) : [],
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`state load failed (${path}), starting fresh:`, err.message)
    return freshState()
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n', 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** The public shape published to GitHub Pages (state/alerts.json). */
export function publicState(state) {
  return {
    version: 1,
    updatedAt: state.updatedAt,
    source: state.priceSource,
    prices: state.prices,
    alerts: state.alerts.map(a => ({
      id: a.id,
      symbol: a.symbol,
      direction: a.direction,
      price: a.price,
      armed: a.armed,
      firedAt: a.firedAt,
    })),
  }
}
