// Node tests for src/companion.ts — run: npm run test:companion.
// A minimal DOM stub: enough of Document/Element for the companion form
// (getElementById, createElement, innerHTML clearing, addEventListener,
// value/textContent, form submit). The real DOM behaviour in the WebView is
// verified separately via the simulator's webview screenshot + console.
import { mountCompanion } from '../src/companion.ts'
import { HOLDINGS_CHANGED_EVENT, HOLDINGS_KEY } from '../src/store.ts'

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.listeners = {}
    this.value = ''
    this.className = ''
    this._text = ''
  }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('')
  }
  set textContent(v) {
    this._text = String(v)
    this.children = []
  }
  get innerHTML() {
    return ''
  }
  set innerHTML(_) {
    this.children = []
  }
  appendChild(child) {
    this.children.push(child)
    return child
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  dispatch(type, event = {}) {
    const evt = { ...event, preventDefault() {} }
    for (const fn of this.listeners[type] || []) fn(evt)
  }
  click() {
    this.dispatch('click')
  }
  focus() {}
}

class FakeDocument {
  constructor() {
    this.byId = {}
    this.defaultView = { addEventListener() {} }
  }
  getElementById(id) {
    return this.byId[id] || null
  }
  createElement(tag) {
    return new FakeElement(tag)
  }
}

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

const doc = new FakeDocument()
for (const id of ['hold-symbol', 'hold-amount', 'hold-cost', 'hold-form', 'hold-error', 'hold-list', 'alert-list']) {
  doc.byId[id] = new FakeElement(id === 'hold-form' ? 'form' : id === 'hold-list' || id === 'alert-list' ? 'ul' : 'input')
}
const store = new FakeStore()
const notified = []
mountCompanion(doc, store, name => notified.push(name))

// Demo holdings render on mount.
const list = doc.getElementById('hold-list')
check('demo holdings listed (3 rows)', list.children.length === 3)
check(
  'first row shows BTC holding',
  list.children[0].textContent.includes('BTC') && list.children[0].textContent.includes('0.42'),
)
const alertList = doc.getElementById('alert-list')
check('demo alerts listed (2 rows)', alertList.children.length === 2)

// Submit: update BTC amount + cost basis.
const form = doc.getElementById('hold-form')
const symbolEl = doc.getElementById('hold-symbol')
const amountEl = doc.getElementById('hold-amount')
const costEl = doc.getElementById('hold-cost')
const errorEl = doc.getElementById('hold-error')
symbolEl.value = 'BTC'
amountEl.value = '1'
costEl.value = '50000'
form.dispatch('submit')
const saved = JSON.parse(store.getItem(HOLDINGS_KEY))
check(
  'submit saves updated BTC holding',
  saved.find(h => h.symbol === 'BTC').amount === 1 && saved.find(h => h.symbol === 'BTC').costBasis === 50000,
)
check('submit notifies glasses app', notified.includes(HOLDINGS_CHANGED_EVENT))
check('submit clears the error', errorEl.textContent === '')
check('list re-renders after submit', list.children.length === 3)

// Submit invalid: empty amount.
amountEl.value = ''
form.dispatch('submit')
check('invalid submit shows an error', errorEl.textContent.length > 0)
check(
  'invalid submit does not change the store',
  JSON.parse(store.getItem(HOLDINGS_KEY)).find(h => h.symbol === 'BTC').amount === 1,
)

// Edit prefills the form.
const firstRow = list.children[0]
const editBtn = firstRow.children.find(c => c.textContent === 'Edit')
amountEl.value = ''
costEl.value = ''
editBtn.click()
check('edit prefills amount', amountEl.value === '1')
check('edit prefills cost basis', costEl.value === '50000')

// Delete removes the holding and notifies.
const delBtn = firstRow.children.find(c => c.textContent === 'Delete')
delBtn.click()
const afterDelete = JSON.parse(store.getItem(HOLDINGS_KEY))
check('delete removes the holding', afterDelete.find(h => h.symbol === 'BTC') === undefined)
check('delete re-renders the list', list.children.length === 2)
check('delete notifies glasses app', notified.filter(n => n === HOLDINGS_CHANGED_EVENT).length >= 2)

if (failures > 0) {
  console.log(`${failures} FAILURES`)
  process.exit(1)
}
console.log('all companion tests passed')
