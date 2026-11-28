// Glancefolio bot — Telegram transport + price source tests (node --test).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getUpdates, sendMessage, TelegramError } from '../src/telegram.mjs'
import { fetchPrices } from '../src/prices.mjs'

const API = 'https://mock.telegram.local'
const TOKEN = 'dummy-token'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('telegram transport', () => {
  it('getUpdates returns updates and the next offset', async () => {
    const calls = []
    const fetchFn = async url => {
      calls.push(url)
      return jsonResponse({
        ok: true,
        result: [
          { update_id: 10, message: { message_id: 1, chat: { id: 7 }, text: '/price' } },
          { update_id: 11, message: { message_id: 2, chat: { id: 7 }, text: '/alerts' } },
        ],
      })
    }
    const { updates, nextOffset } = await getUpdates({ apiBase: API, token: TOKEN, offset: 0, fetchFn })
    assert.equal(updates.length, 2)
    assert.equal(nextOffset, 12)
    assert.match(calls[0], /getUpdates\?offset=0&timeout=30/)
  })

  it('getUpdates with no new updates keeps the offset', async () => {
    const fetchFn = async () => jsonResponse({ ok: true, result: [] })
    const { updates, nextOffset } = await getUpdates({ apiBase: API, token: TOKEN, offset: 42, fetchFn })
    assert.equal(updates.length, 0)
    assert.equal(nextOffset, 42)
  })

  it('sendMessage posts chat_id and text as JSON', async () => {
    let seen
    const fetchFn = async (url, opts) => {
      seen = { url, opts }
      return jsonResponse({ ok: true, result: { message_id: 99 } })
    }
    const ok = await sendMessage({ apiBase: API, token: TOKEN, chatId: 7, text: 'hi', fetchFn })
    assert.equal(ok, true)
    assert.match(seen.url, /\/botdummy-token\/sendMessage$/)
    assert.deepEqual(JSON.parse(seen.opts.body), { chat_id: 7, text: 'hi' })
  })

  it('a 401 becomes a TelegramError with status 401', async () => {
    const fetchFn = async () =>
      jsonResponse({ ok: false, description: 'Unauthorized' }, 401)
    await assert.rejects(
      () => getUpdates({ apiBase: API, token: 'bad', offset: 0, fetchFn }),
      err => err instanceof TelegramError && err.status === 401,
    )
  })
})

describe('price sources', () => {
  it('CoinGecko success wins', async () => {
    const fetchFn = async url => {
      assert.match(url, /coingecko/)
      return jsonResponse({
        bitcoin: { usd: 63_000, usd_24h_change: 1.2 },
        ethereum: { usd: 1_780, usd_24h_change: -0.4 },
        solana: { usd: 75, usd_24h_change: 2.1 },
      })
    }
    const { prices, source } = await fetchPrices(fetchFn)
    assert.equal(source, 'CG')
    assert.equal(prices.BTC.price, 63_000)
    assert.equal(prices.ETH.change24h, -0.4)
  })

  it('CoinGecko failure falls back to Binance Vision', async () => {
    const seen = []
    const fetchFn = async url => {
      seen.push(url)
      if (url.includes('coingecko')) return jsonResponse({}, 500)
      return jsonResponse({ lastPrice: '63100', priceChangePercent: '0.8', highPrice: '64000', lowPrice: '62000' })
    }
    const { prices, source } = await fetchPrices(fetchFn)
    assert.equal(source, 'BIN')
    assert.equal(prices.BTC.price, 63_100)
    assert.equal(seen.filter(u => u.includes('binance')).length, 3)
  })

  it('all sources failing throws', async () => {
    const fetchFn = async () => jsonResponse({}, 500)
    await assert.rejects(() => fetchPrices(fetchFn), /all price sources failed/)
  })
})
