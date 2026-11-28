// Glancefolio bot — alert engine (pure functions, no I/O).
//
// Firing rule (DESIGN.md §3/§13.5): a level fires only after 2 consecutive
// polls beyond it (60 s apart — kills wick false-fires), then a 15-minute
// per-alert cooldown before it can re-fire. A fired alert stays FIRED until
// the user re-arms it or the price returns 1% inside the level (re-arm
// hysteresis).
//
// Runtime state per alert id (kept in bot/state.json, never shown on glass):
//   { beyondCount, cooldownUntil }
// `now` is ms since epoch; callers pass Date.now() (tests pass fake times).

export const FIRE_POLL_COUNT = 2
export const COOLDOWN_MS = 15 * 60 * 1000
export const REARM_HYSTERESIS = 0.01

export function isBeyond(alert, price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return false
  return alert.direction === 'above' ? price > alert.price : price < alert.price
}

/** Price back 1% inside the level (re-arm zone). */
export function isBackInside(alert, price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return false
  if (alert.direction === 'above') return price <= alert.price * (1 - REARM_HYSTERESIS)
  return price >= alert.price * (1 + REARM_HYSTERESIS)
}

/**
 * One poll tick. Returns { alerts, runtime, fired, rearmed } — all new
 * objects; the inputs are not mutated. `fired` / `rearmed` are the alerts
 * that changed state on this tick (for Telegram + publish).
 */
export function evaluateAlerts({ alerts, prices, runtime, now }) {
  const nextAlerts = alerts.map(a => ({ ...a }))
  const nextRuntime = {}
  for (const [id, rt] of Object.entries(runtime ?? {})) {
    nextRuntime[id] = { beyondCount: rt.beyondCount ?? 0, cooldownUntil: rt.cooldownUntil ?? 0 }
  }
  const fired = []
  const rearmed = []

  for (const alert of nextAlerts) {
    const rt = (nextRuntime[alert.id] ??= { beyondCount: 0, cooldownUntil: 0 })
    const quote = prices[alert.symbol]
    const price = quote?.price

    // Fired alerts: only the re-arm check applies (no re-fire while FIRED).
    if (alert.firedAt !== null) {
      if (isBackInside(alert, price)) {
        alert.firedAt = null
        // Keep the cooldown: the alert may not re-fire until it lapses.
        rt.cooldownUntil = Math.max(rt.cooldownUntil, now + COOLDOWN_MS)
        rearmed.push({ ...alert })
      }
      rt.beyondCount = 0
      continue
    }

    if (!alert.armed || price === undefined) {
      rt.beyondCount = 0
      continue
    }
    if (now < rt.cooldownUntil) {
      rt.beyondCount = 0
      continue
    }
    if (isBeyond(alert, price)) {
      rt.beyondCount += 1
      if (rt.beyondCount >= FIRE_POLL_COUNT) {
        alert.firedAt = now
        rt.cooldownUntil = now + COOLDOWN_MS
        rt.beyondCount = 0
        fired.push({ ...alert, firedPrice: price })
      }
    } else {
      rt.beyondCount = 0
    }
  }

  return { alerts: nextAlerts, runtime: nextRuntime, fired, rearmed }
}
