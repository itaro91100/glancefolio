// Node tests for src/store.ts — run: npm run test:store (esbuild bundle + node).
// No DOM, no network: a Map-backed fake store.
import {
  ALERTS_KEY,
  DEMO_ALERTS,
  DEMO_HOLDINGS,
  HOLDINGS_KEY,
  alertId,
  alertsForSymbol,
  loadAlerts,
  loadHoldings,
  loadSettings,
  removeAlert,
  removeHolding,
  saveAlerts,
  saveHoldings,
  sortAlerts,
  upsertAlert,
  upsertHolding,
  validateHolding,
} from '../src/store.ts'

class FakeStore {
  constructor() {
    this.map = new Map()
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    this.map.set(k, v)
  }
  removeItem(k) {
    this.map.delete(k)
  }
}

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failures++
    console.log(`FAIL ${name}`)
  }
}
function eq(name, got, want) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))
}

// --- holdings ---------------------------------------------------------------
{
  const s = new FakeStore()
  const first = loadHoldings(s)
  eq('first load seeds demo holdings', first, DEMO_HOLDINGS)
  check('seed written to store', s.getItem(HOLDINGS_KEY) !== null)

  const added = upsertHolding(first, { symbol: 'BTC', amount: 1, costBasis: 50000 })
  eq('upsert updates existing coin in place', added.find(h => h.symbol === 'BTC'), {
    symbol: 'BTC',
    amount: 1,
    costBasis: 50000,
  })
  check('upsert keeps other holdings', added.length === 3)
  saveHoldings(s, added)
  eq('save/load round-trip', loadHoldings(s), added)

  const removed = removeHolding(added, 'ETH')
  eq('removeHolding drops the coin', removed.map(h => h.symbol), ['BTC', 'SOL'])

  saveHoldings(s, [])
  eq('explicit empty list stays empty (no re-seed)', loadHoldings(s), [])

  s.setItem(HOLDINGS_KEY, 'not json{')
  eq('corrupt holdings fall back to demo', loadHoldings(s), DEMO_HOLDINGS)

  s.setItem(
    HOLDINGS_KEY,
    JSON.stringify([{ symbol: 'DOGE', amount: 5, costBasis: null }, { symbol: 'BTC', amount: 0.1, costBasis: null }]),
  )
  eq('unknown coins filtered out', loadHoldings(s), [{ symbol: 'BTC', amount: 0.1, costBasis: null }])
}

// --- validation ---------------------------------------------------------------
eq('validate ok', validateHolding('BTC', 0.5, 60000), null)
eq('validate ok, empty cost basis', validateHolding('ETH', 2, null), null)
check('validate rejects unknown coin', validateHolding('DOGE', 1, null) !== null)
check('validate rejects zero amount', validateHolding('BTC', 0, null) !== null)
check('validate rejects NaN amount', validateHolding('BTC', NaN, null) !== null)
check('validate rejects negative cost', validateHolding('BTC', 1, -5) !== null)
check('validate rejects huge amount', validateHolding('BTC', 2e9, null) !== null)

// --- alerts -------------------------------------------------------------------
{
  const s = new FakeStore()
  const first = loadAlerts(s)
  eq('first load seeds demo alerts', first, DEMO_ALERTS)
  check('alert seed written', s.getItem(ALERTS_KEY) !== null)

  const next = upsertAlert(first, {
    id: alertId('ETH', 'above'),
    symbol: 'ETH',
    direction: 'above',
    price: 2000,
    armed: true,
    firedAt: null,
  })
  check('upsert adds a new alert', next.length === 3)
  const toggled = next.map(a => (a.id === 'ETH-above' ? { ...a, armed: false } : a))
  saveAlerts(s, toggled)
  eq('save/load round-trip keeps armed flag', loadAlerts(s).find(a => a.id === 'ETH-above').armed, false)

  const dropped = removeAlert(toggled, 'SOL-below')
  eq('removeAlert drops by id', dropped.map(a => a.id), ['BTC-above', 'ETH-above'])

  const ordered = alertsForSymbol(
    [
      { id: 'BTC-below', symbol: 'BTC', direction: 'below', price: 50000, armed: true, firedAt: null },
      { id: 'BTC-above', symbol: 'BTC', direction: 'above', price: 70000, armed: true, firedAt: null },
      { id: 'ETH-above', symbol: 'ETH', direction: 'above', price: 2000, armed: true, firedAt: null },
    ],
    'BTC',
  )
  eq('alertsForSymbol: above before below', ordered.map(a => a.id), ['BTC-above', 'BTC-below'])

  const sorted = sortAlerts([
    { id: 'SOL-below', symbol: 'SOL', direction: 'below', price: 70, armed: true, firedAt: null },
    { id: 'ETH-above', symbol: 'ETH', direction: 'above', price: 2000, armed: true, firedAt: null },
    { id: 'BTC-below', symbol: 'BTC', direction: 'below', price: 50000, armed: true, firedAt: null },
    { id: 'BTC-above', symbol: 'BTC', direction: 'above', price: 70000, armed: true, firedAt: null },
  ])
  eq('sortAlerts: coin order, above first', sorted.map(a => a.id), [
    'BTC-above',
    'BTC-below',
    'ETH-above',
    'SOL-below',
  ])

  saveAlerts(s, [])
  eq('explicit empty alerts stay empty', loadAlerts(s), [])
}

// --- settings -------------------------------------------------------------------
{
  const s = new FakeStore()
  eq('default pollSeconds', loadSettings(s), { pollSeconds: 60 })
  s.setItem('glancefolio:v1:settings', JSON.stringify({ pollSeconds: 120 }))
  eq('valid pollSeconds kept', loadSettings(s), { pollSeconds: 120 })
  s.setItem('glancefolio:v1:settings', JSON.stringify({ pollSeconds: 5 }))
  eq('too-small pollSeconds rejected', loadSettings(s), { pollSeconds: 60 })
  s.setItem('glancefolio:v1:settings', JSON.stringify({ pollSeconds: 1000 }))
  eq('too-large pollSeconds rejected', loadSettings(s), { pollSeconds: 60 })
  s.setItem('glancefolio:v1:settings', 'garbage')
  eq('corrupt settings rejected', loadSettings(s), { pollSeconds: 60 })
}

if (failures > 0) {
  console.log(`${failures} FAILURES`)
  process.exit(1)
}
console.log('all store tests passed')
