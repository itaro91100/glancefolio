// Glancefolio bot — command tests (node --test).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeCommand, parseCommand, HELP_TEXT } from '../src/commands.mjs'

function ctx(overrides = {}) {
  return {
    state: {
      holdings: [{ symbol: 'BTC', amount: 0.42, costBasis: 60_000 }],
      alerts: [
        { id: 'BTC-above', symbol: 'BTC', direction: 'above', price: 70_000, armed: true, firedAt: null },
      ],
      runtime: {},
      prices: {},
      priceSource: 'CG',
    },
    prices: {
      BTC: { price: 63_177, change24h: 1.0 },
      ETH: { price: 1_781, change24h: -0.5 },
      SOL: { price: 75.93, change24h: 2.3 },
    },
    priceSource: 'CG',
    now: 1_000_000,
    ...overrides,
  }
}

describe('parseCommand', () => {
  it('parses /price BTC', () => {
    assert.deepEqual(parseCommand('/price BTC'), { cmd: 'price', args: ['BTC'] })
  })
  it('strips the @bot suffix', () => {
    assert.deepEqual(parseCommand('/price@GlancefolioBot'), { cmd: 'price', args: [] })
  })
  it('returns null for plain text', () => {
    assert.equal(parseCommand('hello'), null)
  })
})

describe('executeCommand', () => {
  it('/price lists all coins', () => {
    const { reply, changed } = executeCommand('/price', ctx())
    assert.match(reply, /BTC \$63,177 ▲1\.0%/)
    assert.match(reply, /ETH \$1,781/)
    assert.match(reply, /SOL \$75\.93/)
    assert.equal(changed, false)
  })

  it('/price BTC shows one coin', () => {
    const { reply } = executeCommand('/price btc', ctx())
    assert.match(reply, /BTC \$63,177/)
    assert.doesNotMatch(reply, /ETH/)
  })

  it('/price XXX rejects an unknown coin', () => {
    const { reply } = executeCommand('/price XXX', ctx())
    assert.match(reply, /Unknown coin/)
  })

  it('/alert arms a new alert and resets its runtime', () => {
    const c = ctx()
    c.state.runtime['SOL-below'] = { beyondCount: 1, cooldownUntil: 999 }
    const { reply, changed } = executeCommand('/alert SOL below 70', c)
    assert.match(reply, /Armed: ● SOL < \$70\.00/)
    assert.equal(changed, true)
    assert.equal(c.state.alerts.length, 2)
    assert.equal(c.state.runtime['SOL-below'], undefined)
  })

  it('/alert with bad usage explains itself', () => {
    const { reply, changed } = executeCommand('/alert BTC sideways 5', ctx())
    assert.match(reply, /Usage: \/alert/)
    assert.equal(changed, false)
  })

  it('/alerts lists armed and fired alerts', () => {
    const c = ctx()
    c.state.alerts.push({ id: 'SOL-below', symbol: 'SOL', direction: 'below', price: 70, armed: true, firedAt: 5000 })
    const { reply } = executeCommand('/alerts', c)
    assert.match(reply, /● BTC > \$70,000/)
    assert.match(reply, /✓ SOL < \$70\.00/)
  })

  it('/portfolio shows total and P&L', () => {
    const { reply } = executeCommand('/portfolio', ctx())
    assert.match(reply, /Total \$26,534/)
    assert.match(reply, /P&L \+\$1,334/)
  })

  it('/add upserts a holding', () => {
    const c = ctx()
    const { reply, changed } = executeCommand('/add ETH 2.5 1700', c)
    assert.match(reply, /Holding: ETH 2\.5 @ \$1,700/)
    assert.equal(changed, true)
    assert.equal(c.state.holdings.length, 2)
  })

  it('/remove deletes a holding', () => {
    const c = ctx()
    const { reply, changed } = executeCommand('/remove BTC', c)
    assert.match(reply, /Removed BTC/)
    assert.equal(changed, true)
    assert.equal(c.state.holdings.length, 0)
  })

  it('/delalert removes an alert', () => {
    const c = ctx()
    const { reply, changed } = executeCommand('/delalert BTC above', c)
    assert.match(reply, /Removed alert BTC-above/)
    assert.equal(changed, true)
    assert.equal(c.state.alerts.length, 0)
  })

  it('/help returns the help text', () => {
    const { reply } = executeCommand('/help', ctx())
    assert.equal(reply, HELP_TEXT)
  })

  it('unknown command is answered, not ignored', () => {
    const { reply } = executeCommand('/explode', ctx())
    assert.match(reply, /Unknown command/)
  })

  it('plain text returns null reply', () => {
    const { reply } = executeCommand('hello there', ctx())
    assert.equal(reply, null)
  })
})
