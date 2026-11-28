// Glancefolio bot — Telegram transport (long-polling, zero dependencies).
//
// Thin wrapper over the Bot API: getUpdates (long poll, 30 s) + sendMessage.
// The API base is overridable (TELEGRAM_API_BASE) so tests can point at a
// local mock server. No command logic here — see commands.mjs.
// A 401 means the token is wrong/revoked: the caller must stop polling
// (never spin on auth errors).

export class TelegramError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'TelegramError'
    this.status = status
  }
}

export function apiUrl(apiBase, token, method) {
  return `${apiBase.replace(/\/$/, '')}/bot${token}/${method}`
}

/** One getUpdates call. Returns { updates, nextOffset }. Throws TelegramError. */
export async function getUpdates({ apiBase, token, offset, timeoutSec = 30, fetchFn = fetch }) {
  const url =
    `${apiUrl(apiBase, token, 'getUpdates')}?offset=${offset}&timeout=${timeoutSec}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 15) * 1000)
  try {
    const res = await fetchFn(url, { signal: ctrl.signal })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new TelegramError(
        `getUpdates HTTP ${res.status}: ${body.description ?? 'unknown error'}`,
        res.status,
      )
    }
    if (!body.ok) throw new TelegramError(`getUpdates failed: ${body.description ?? '?'}`, res.status)
    const updates = Array.isArray(body.result) ? body.result : []
    const maxId = updates.reduce((m, u) => Math.max(m, u.update_id ?? 0), 0)
    return { updates, nextOffset: maxId > 0 ? maxId + 1 : offset }
  } finally {
    clearTimeout(timer)
  }
}

/** Send one text message. Returns true on success. Throws TelegramError. */
export async function sendMessage({ apiBase, token, chatId, text, fetchFn = fetch }) {
  const res = await fetchFn(apiUrl(apiBase, token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) {
    throw new TelegramError(
      `sendMessage HTTP ${res.status}: ${body.description ?? 'unknown error'}`,
      res.status,
    )
  }
  return true
}

/**
 * Long-poll loop. Calls `onUpdate(update)` for each message update.
 * Resolves only when `shouldStop()` is true or the token is rejected (401).
 * Network errors back off 5 s and retry — the loop never dies on them.
 */
export async function runLongPoll({ apiBase, token, fetchFn = fetch, onUpdate, shouldStop, onError }) {
  let offset = 0
  for (;;) {
    if (shouldStop()) return { stopped: true }
    let batch
    try {
      batch = await getUpdates({ apiBase, token, offset, fetchFn })
    } catch (err) {
      if (err instanceof TelegramError && err.status === 401) {
        onError?.(err)
        return { stopped: false, authError: true }
      }
      onError?.(err)
      await new Promise(r => setTimeout(r, 5_000))
      continue
    }
    offset = batch.nextOffset
    for (const update of batch.updates) {
      try {
        await onUpdate(update)
      } catch (err) {
        onError?.(err)
      }
      if (shouldStop()) return { stopped: true }
    }
  }
}
