// Glancefolio bot — price fetching (Node, zero dependencies).
//
// Same fallback chain as the glasses app (DESIGN.md §3): CoinGecko
// (primary) -> Binance Vision -> Kraken. One CoinGecko call covers all
// three coins; Binance Vision needs one call per symbol; Kraken one call.
// Uses the global fetch (Node 18+). Pure network code — no state.

export const COINS = [
  { symbol: 'BTC', geckoId: 'bitcoin', binance: 'BTCUSDT', kraken: 'XBTUSD' },
  { symbol: 'ETH', geckoId: 'ethereum', binance: 'ETHUSDT', kraken: 'ETHUSD' },
  { symbol: 'SOL', geckoId: 'solana', binance: 'SOLUSDT', kraken: 'SOLUSD' },
]

const FETCH_TIMEOUT_MS = 10_000

async function fetchJson(url, fetchFn = fetch) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchFromCoinGecko(fetchFn = fetch) {
  const ids = COINS.map(c => c.geckoId).join(',')
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    `&vs_currencies=usd&include_24hr_change=true`
  const data = await fetchJson(url, fetchFn)
  const out = {}
  for (const coin of COINS) {
    const row = data[coin.geckoId]
    if (!row || typeof row.usd !== 'number') throw new Error(`no ${coin.symbol} in CoinGecko reply`)
    out[coin.symbol] = { price: row.usd, change24h: row.usd_24h_change ?? null }
  }
  return out
}

export async function fetchFromBinanceVision(fetchFn = fetch) {
  const rows = await Promise.all(
    COINS.map(async coin => {
      const data = await fetchJson(
        `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${coin.binance}`,
        fetchFn,
      )
      return {
        coin,
        price: Number(data.lastPrice),
        change: Number(data.priceChangePercent),
      }
    }),
  )
  const out = {}
  for (const { coin, price, change } of rows) {
    if (!Number.isFinite(price)) throw new Error(`no ${coin.symbol} in Binance reply`)
    out[coin.symbol] = { price, change24h: Number.isFinite(change) ? change : null }
  }
  return out
}

export async function fetchFromKraken(fetchFn = fetch) {
  const pairs = COINS.map(c => c.kraken).join(',')
  const data = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, fetchFn)
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join('; ')}`)
  const out = {}
  for (const coin of COINS) {
    const row = data.result[coin.kraken]
    const price = row ? Number(row.c?.[0]) : NaN
    if (!Number.isFinite(price)) throw new Error(`no ${coin.symbol} in Kraken reply`)
    out[coin.symbol] = { price, change24h: null }
  }
  return out
}

/** CoinGecko -> Binance Vision -> Kraken. Returns { prices, source }. */
export async function fetchPrices(fetchFn = fetch) {
  try {
    return { prices: await fetchFromCoinGecko(fetchFn), source: 'CG' }
  } catch (e1) {
    try {
      return { prices: await fetchFromBinanceVision(fetchFn), source: 'BIN' }
    } catch (e2) {
      const err = new Error(`all price sources failed (CG: ${e1.message}; BIN: ${e2.message})`)
      try {
        return { prices: await fetchFromKraken(fetchFn), source: 'KRAK' }
      } catch (e3) {
        err.message += `; KRAK: ${e3.message}`
        throw err
      }
    }
  }
}
