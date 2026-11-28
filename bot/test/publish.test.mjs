// Glancefolio bot — publish tests (node --test).
// Uses a real local git repo (bare remote + clone) in a temp dir — no
// network, no GitHub. Verifies: first publish writes + commits + pushes,
// a second publish with the same doc is a no-op, a changed doc commits.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { publishState } from '../src/publish.mjs'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', args, { cwd })

let dir
let remote
let clone

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glancefolio-publish-'))
  remote = join(dir, 'remote.git')
  clone = join(dir, 'clone')
  await exec('git', ['init', '--bare', remote])
  await exec('git', ['clone', remote, clone])
  await git(clone, 'config', 'user.name', 'test')
  await git(clone, 'config', 'user.email', 'test@example.com')
  await git(clone, 'checkout', '-b', 'gh-pages')
  await writeFile(join(clone, 'state.json'), '{}\n')
  await git(clone, 'add', '.')
  await git(clone, 'commit', '-m', 'init')
  await git(clone, 'push', 'origin', 'gh-pages')
})

after(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
})

const DOC1 = {
  version: 1,
  updatedAt: 1_000_000,
  source: 'CG',
  prices: { BTC: { price: 63_000, change24h: 1 } },
  alerts: [],
}

describe('publishState', () => {
  it('publishes a new doc and pushes it', async () => {
    const res = await publishState(clone, DOC1)
    assert.equal(res.changed, true)
    assert.equal(res.pushed, true)
    const body = await readFile(join(clone, 'state', 'alerts.json'), 'utf8')
    assert.deepEqual(JSON.parse(body), DOC1)
    const log = await git(clone, 'log', '--oneline')
    assert.match(log.stdout, /bot state/)
  })

  it('is a no-op when the doc is unchanged', async () => {
    const res = await publishState(clone, DOC1)
    assert.equal(res.changed, false)
    assert.equal(res.pushed, false)
  })

  it('publishes again when the doc changes', async () => {
    const doc2 = { ...DOC1, updatedAt: 2_000_000, alerts: [{ id: 'BTC-below', symbol: 'BTC', direction: 'below', price: 70_000, armed: true, firedAt: 2_000_000 }] }
    const res = await publishState(clone, doc2)
    assert.equal(res.changed, true)
    assert.equal(res.pushed, true)
    const body = await readFile(join(clone, 'state', 'alerts.json'), 'utf8')
    assert.deepEqual(JSON.parse(body), doc2)
  })
})
