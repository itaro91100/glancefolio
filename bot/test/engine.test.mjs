// Glancefolio bot — engine tests (node --test).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAlerts, COOLDOWN_MS } from '../src/engine.mjs'

const ALERT = { id: 'BTC-below', symbol: 'BTC', direction: 'below', price: 70_000, armed: true, firedAt: null }
const PRICES_BELOW = { BTC: { price: 63_000, change24h: -1 } }
const PRICES_ABOVE = { BTC: { price: 71_000, change24h: 1 } }

describe('evaluateAlerts', () => {
  it('does not fire on a single poll beyond the level', () => {
    const r = evaluateAlerts({ alerts: [ALERT], prices: PRICES_BELOW, runtime: {}, now: 1000 })
    assert.equal(r.fired.length, 0)
    assert.equal(r.alerts[0].firedAt, null)
    assert.equal(r.runtime['BTC-below'].beyondCount, 1)
  })

  it('fires on the second consecutive poll beyond the level', () => {
    const first = evaluateAlerts({ alerts: [ALERT], prices: PRICES_BELOW, runtime: {}, now: 1000 })
    const second = evaluateAlerts({
      alerts: first.alerts,
      prices: PRICES_BELOW,
      runtime: first.runtime,
      now: 61_000,
    })
    assert.equal(second.fired.length, 1)
    assert.equal(second.alerts[0].firedAt, 61_000)
    assert.equal(second.fired[0].firedPrice, 63_000)
    assert.equal(second.runtime['BTC-below'].cooldownUntil, 61_000 + COOLDOWN_MS)
  })

  it('resets the count when the price comes back inside', () => {
    const first = evaluateAlerts({ alerts: [ALERT], prices: PRICES_BELOW, runtime: {}, now: 1000 })
    const second = evaluateAlerts({
      alerts: first.alerts,
      prices: PRICES_ABOVE,
      runtime: first.runtime,
      now: 61_000,
    })
    assert.equal(second.fired.length, 0)
    assert.equal(second.runtime['BTC-below'].beyondCount, 0)
  })

  it('does not fire a disarmed alert', () => {
    const off = { ...ALERT, armed: false }
    let rt = {}
    for (let i = 0; i < 3; i++) {
      const r = evaluateAlerts({ alerts: [off], prices: PRICES_BELOW, runtime: rt, now: 1000 + i * 60_000 })
      rt = r.runtime
      assert.equal(r.fired.length, 0)
    }
  })

  it('auto re-arms a fired alert when the price returns 1% inside', () => {
    const fired = { ...ALERT, firedAt: 1000 }
    const r = evaluateAlerts({
      alerts: [fired],
      prices: { BTC: { price: 70_700, change24h: 0 } }, // 1% above a 70k below-level
      runtime: { 'BTC-below': { beyondCount: 0, cooldownUntil: 1000 + COOLDOWN_MS } },
      now: 2000,
    })
    assert.equal(r.rearmed.length, 1)
    assert.equal(r.alerts[0].firedAt, null)
  })

  it('does not re-fire during the cooldown after re-arm', () => {
    const fired = { ...ALERT, firedAt: 1000 }
    const rearmed = evaluateAlerts({
      alerts: [fired],
      prices: { BTC: { price: 70_700, change24h: 0 } },
      runtime: { 'BTC-below': { beyondCount: 0, cooldownUntil: 1000 + COOLDOWN_MS } },
      now: 2000,
    })
    // Price crosses below again immediately, but the cooldown is still on.
    let rt = rearmed.runtime
    let alerts = rearmed.alerts
    for (let i = 0; i < 3; i++) {
      const r = evaluateAlerts({
        alerts,
        prices: PRICES_BELOW,
        runtime: rt,
        now: 3000 + i * 60_000,
      })
      rt = r.runtime
      alerts = r.alerts
      assert.equal(r.fired.length, 0, `tick ${i} must not fire during cooldown`)
    }
  })

  it('fires again after the cooldown lapses and the price re-crosses', () => {
    const afterCooldown = 1000 + COOLDOWN_MS + 60_000
    const r1 = evaluateAlerts({
      alerts: [{ ...ALERT, firedAt: null }],
      prices: PRICES_BELOW,
      runtime: { 'BTC-below': { beyondCount: 0, cooldownUntil: 1000 + COOLDOWN_MS } },
      now: afterCooldown,
    })
    assert.equal(r1.fired.length, 0)
    const r2 = evaluateAlerts({
      alerts: r1.alerts,
      prices: PRICES_BELOW,
      runtime: r1.runtime,
      now: afterCooldown + 60_000,
    })
    assert.equal(r2.fired.length, 1)
  })
})
