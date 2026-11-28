// Glancefolio bot — end-to-end Telegram test (node --test).
//
// Spins a local mock Telegram server, starts the real bot (index.mjs)
// against it with a fast poll, and asserts a /price update gets a reply
// with a real price. No real Telegram, no token. The bot also polls live
// prices (CoinGecko) — that is the point: the reply carries real data.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

let server
let port
let dir
const sent = []
let updateDelivered = false

function handle(req, res) {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.includes('/getUpdates')) {
      const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset') ?? 0)
      if (!updateDelivered && offset <= 100) {
        updateDelivered = true
        res.end(JSON.stringify({
          ok: true,
          result: [{
            update_id: 100,
            message: { message_id: 1, chat: { id: 4242 }, text: '/price BTC' },
          }],
        }))
      } else {
        res.end(JSON.stringify({ ok: true, result: [] }))
      }
      return
    }
    if (req.url.includes('/sendMessage')) {
      sent.push(JSON.parse(body))
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, description: 'not found' }))
  })
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glancefolio-e2e-'))
  server = createServer(handle)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  server.close()
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
})

describe('bot end-to-end (mock Telegram)', () => {
  it('/price BTC gets a reply with a live price', { timeout: 30_000 }, async () => {
    const bot = spawn(process.execPath, ['src/index.mjs'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        GLANCEFOLIO_BOT_TOKEN: 'mock-token',
        TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
        BOT_STATE_PATH: join(dir, 'state.json'),
        BOT_PAGES_DIR: join(dir, 'pages'),
        BOT_POLL_SECONDS: '5',
        BOT_HEARTBEAT_SECONDS: '3600',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    bot.stdout.on('data', d => { stdout += d })
    bot.stderr.on('data', d => { stdout += d })
    try {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (sent.length > 0) break
        await new Promise(r => setTimeout(r, 500))
      }
      assert.ok(sent.length > 0, `bot never replied; output:\n${stdout}`)
      assert.equal(sent[0].chat_id, 4242)
      assert.match(sent[0].text, /BTC \$[\d,]+/)
      assert.match(sent[0].text, /src: (CG|BIN|KRAK)/)
      const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.ok(state.prices.BTC?.price > 0, 'state.json has a live BTC price')
      assert.ok(state.chatIds.includes(4242), 'chat id remembered for alerts')
    } finally {
      bot.kill('SIGTERM')
      await new Promise(r => bot.on('exit', r))
    }
  })
})
