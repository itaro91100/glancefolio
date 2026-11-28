// Companion page — holdings entry on the phone (DESIGN.md §8 Day 2).
//
// The companion page is the same document the glasses app runs in, so the
// form writes straight to the shared store (`glancefolio:v1:*`) and notifies
// the glasses app through a window event; the glasses re-read the store and
// re-render. No network, no server — localStorage only.
//
// Kept DOM-pure (no `window` access) so it can be unit-tested in Node with a
// small DOM stub: `notify` is how the caller (main.ts) bridges to the window.

import {
  ALERTS_CHANGED_EVENT,
  COIN_SYMBOLS,
  HOLDINGS_CHANGED_EVENT,
  isCoinSymbol,
  loadAlerts,
  loadHoldings,
  removeHolding,
  saveHoldings,
  sortAlerts,
  upsertHolding,
  validateHolding,
  type Alert,
  type Holding,
  type StoreLike,
} from './store'

function fmtMoney(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function fmtAlert(a: Alert): string {
  const dir = a.direction === 'above' ? '>' : '<'
  const state = a.firedAt !== null ? 'FIRED' : a.armed ? 'armed' : 'off'
  return `${a.symbol} ${dir} ${fmtMoney(a.price)} · ${state}`
}

function el(
  doc: Document,
  tag: string,
  text: string,
  className?: string,
): HTMLElement {
  const node = doc.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

export function mountCompanion(
  doc: Document,
  store: StoreLike,
  notify: (eventName: string) => void,
): void {
  const symbolElRaw = doc.getElementById('hold-symbol') as HTMLSelectElement | null
  const amountElRaw = doc.getElementById('hold-amount') as HTMLInputElement | null
  const costElRaw = doc.getElementById('hold-cost') as HTMLInputElement | null
  const formElRaw = doc.getElementById('hold-form') as HTMLFormElement | null
  const errorElRaw = doc.getElementById('hold-error')
  const listElRaw = doc.getElementById('hold-list')
  const alertListElRaw = doc.getElementById('alert-list')
  if (!symbolElRaw || !amountElRaw || !costElRaw || !formElRaw || !errorElRaw || !listElRaw || !alertListElRaw) {
    // Not the companion page (or the page predates the form) — nothing to mount.
    return
  }
  // Narrowed aliases: the guard above proves these non-null, and the aliases
  // keep that narrowing inside the closures below (TS cannot narrow the
  // `*Raw` variables once they are captured).
  const symbolEl = symbolElRaw
  const amountEl = amountElRaw
  const costEl = costElRaw
  const formEl = formElRaw
  const errorEl = errorElRaw
  const listEl = listElRaw
  const alertListEl = alertListElRaw

  // Keep the coin picker to the coins the glasses app knows.
  symbolEl.innerHTML = ''
  for (const symbol of COIN_SYMBOLS) {
    const option = doc.createElement('option')
    option.textContent = symbol
    option.value = symbol
    symbolEl.appendChild(option)
  }

  function renderLists(): void {
    const holdings = loadHoldings(store)
    listEl.innerHTML = ''
    if (holdings.length === 0) {
      listEl.appendChild(el(doc, 'li', 'No holdings yet — add one above.', 'muted'))
    }
    for (const h of holdings) {
      const row = doc.createElement('li')
      const cost =
        h.costBasis === null ? 'no cost basis' : `cost ${fmtMoney(h.costBasis)}/unit`
      row.appendChild(el(doc, 'span', `${h.symbol} — ${h.amount} · ${cost}`))
      const edit = el(doc, 'button', 'Edit')
      edit.addEventListener('click', () => {
        symbolEl.value = h.symbol
        amountEl.value = String(h.amount)
        costEl.value = h.costBasis === null ? '' : String(h.costBasis)
        errorEl.textContent = ''
        amountEl.focus()
      })
      const del = el(doc, 'button', 'Delete')
      del.addEventListener('click', () => {
        saveHoldings(store, removeHolding(loadHoldings(store), h.symbol))
        notify(HOLDINGS_CHANGED_EVENT)
        renderLists()
      })
      row.appendChild(edit)
      row.appendChild(del)
      listEl.appendChild(row)
    }

    const alerts = sortAlerts(loadAlerts(store))
    alertListEl.innerHTML = ''
    if (alerts.length === 0) {
      alertListEl.appendChild(el(doc, 'li', 'No alerts yet — tap a coin on the glasses to set one.', 'muted'))
    }
    for (const a of alerts) {
      alertListEl.appendChild(el(doc, 'li', fmtAlert(a)))
    }
  }

  formEl.addEventListener('submit', event => {
    event.preventDefault()
    const symbol = symbolEl.value
    const amount = amountEl.value.trim() === '' ? NaN : Number(amountEl.value)
    const costRaw = costEl.value.trim()
    const costBasis = costRaw === '' ? null : Number(costRaw)
    if (!isCoinSymbol(symbol)) {
      errorEl.textContent = 'Unknown coin'
      return
    }
    const problem = validateHolding(symbol, amount, costBasis)
    if (problem) {
      errorEl.textContent = problem
      return
    }
    const holding: Holding = { symbol, amount, costBasis }
    saveHoldings(store, upsertHolding(loadHoldings(store), holding))
    errorEl.textContent = ''
    amountEl.value = ''
    costEl.value = ''
    notify(HOLDINGS_CHANGED_EVENT)
    renderLists()
  })

  // Alerts can change on the glasses (tap cycles them) — re-render the list.
  const win = doc.defaultView
  win?.addEventListener(ALERTS_CHANGED_EVENT, () => renderLists())

  renderLists()
}
