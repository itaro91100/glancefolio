// Glancefolio bot — publish the public state to GitHub Pages.
//
// The bot keeps a git worktree of the `gh-pages` branch at `pagesDir`
// (created once with `git worktree add`). Each publish writes
// state/alerts.json there; when the content changed it commits and pushes,
// which triggers a Pages rebuild. Publishing is best-effort: a git failure
// is logged and never crashes the poll loop — the local state.json stays
// the source of truth and the next publish retries.

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(pagesDir, ...args) {
  return execFileAsync('git', args, { cwd: pagesDir, timeout: 60_000 })
}

/**
 * Publish `doc` (already the public shape) to state/alerts.json.
 * Returns { changed, pushed, error? }. Never throws.
 */
export async function publishState(pagesDir, doc) {
  const rel = 'state/alerts.json'
  const body = JSON.stringify(doc, null, 2) + '\n'
  try {
    await mkdir(`${pagesDir}/state`, { recursive: true })
    let previous = null
    try {
      previous = await readFile(`${pagesDir}/${rel}`, 'utf8')
    } catch {
      // No previous file — first publish.
    }
    if (previous === body) return { changed: false, pushed: false }
    await writeFile(`${pagesDir}/${rel}`, body, 'utf8')
    try {
      await git(pagesDir, 'add', rel)
      await git(pagesDir, 'commit', '-m', `bot state ${new Date(doc.updatedAt).toISOString()}`)
    } catch (err) {
      // Nothing to commit (e.g. a concurrent publish wrote the same body).
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
      if (!/nothing to commit/i.test(out)) throw err
      return { changed: true, pushed: false }
    }
    try {
      await git(pagesDir, 'pull', '--rebase', 'origin', 'gh-pages')
      await git(pagesDir, 'push', 'origin', 'gh-pages')
    } catch (err) {
      // Push failed (offline / conflict) — keep the local commit; the next
      // publish retries. The local commit is not lost.
      console.log('publish push failed, will retry next time:', err.message)
      return { changed: true, pushed: false, error: err.message }
    }
    return { changed: true, pushed: true }
  } catch (err) {
    console.log('publish failed:', err.message)
    return { changed: false, pushed: false, error: err.message }
  }
}
