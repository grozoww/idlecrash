// IdleCrash server: one process. It runs the rounds, serves the game page, and
// talks to the page over a WebSocket. The Claude Code mod only tells it whether
// Claude is working (POST /presence) and asks for a link to open the page.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { DEFAULTS, Game, type Account, type ActionError, type Config, type Snapshot } from './engine'
import { HourlyLimit, clientKey } from './limits'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR ?? './data'
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const cfg: Config = {
  ...DEFAULTS,
  botPct: Number(process.env.BOT_PCT ?? DEFAULTS.botPct),
  bettingMs: Number(process.env.BETTING_MS ?? DEFAULTS.bettingMs),
  crashedMs: Number(process.env.CRASHED_MS ?? DEFAULTS.crashedMs),
  maxMultiplier: Number(process.env.MAX_MULTIPLIER ?? DEFAULTS.maxMultiplier),
}

const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? 10)
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS ?? 5000)
const ACCOUNTS_PER_IP_HOUR = Number(process.env.ACCOUNTS_PER_IP_HOUR ?? 10)

const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json')
mkdirSync(DATA_DIR, { recursive: true })

const game = new Game(cfg)
try {
  game.importAccounts(JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')).accounts ?? [])
  console.log(`loaded ${game.accounts.size} accounts`)
} catch {
  console.log('no saved accounts yet')
}

function save(): void {
  if (!game.isDirty) return
  game.isDirty = false
  const tmp = `${ACCOUNTS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify({ accounts: game.exportAccounts() }))
  renameSync(tmp, ACCOUNTS_FILE)
}

setInterval(() => game.tick(Date.now()), 50)
setInterval(save, 5000)
game.pruneAccounts(Date.now())
setInterval(() => game.pruneAccounts(Date.now()), 3600_000)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    save()
    process.exit(0)
  })
}

// ---- the page ---------------------------------------------------------------

const WEB_DIR = new URL('../web/', import.meta.url).pathname

/** The page's script is bundled once at start, from the same scene code the mod ships. */
async function bundlePage(): Promise<string> {
  const result = await Bun.build({ entrypoints: [`${WEB_DIR}main.ts`], target: 'browser' })
  if (!result.success) throw new Error(`cannot bundle the page: ${result.logs.join('\n')}`)
  return await result.outputs[0]!.text()
}

const indexHtml = await Bun.file(`${WEB_DIR}index.html`).text()
const gameJs = await bundlePage()

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

// ---- rate limit: token bucket per IP ----------------------------------------

const buckets = new Map<string, { tokens: number; at: number }>()
const RATE = 40 // requests per second
const BURST = 80
setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip)
}, 60_000)

function isAllowed(ip: string): boolean {
  const now = Date.now()
  const b = buckets.get(ip) ?? { tokens: BURST, at: now }
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE)
  b.at = now
  const ok = b.tokens >= 1
  if (ok) b.tokens -= 1
  buckets.set(ip, b)
  return ok
}

/** New accounts per IP per hour: an account costs us memory, so a script must not make millions. */
const accountLimit = new HourlyLimit(ACCOUNTS_PER_IP_HOUR)
setInterval(() => accountLimit.sweep(Date.now()), 600_000)

// ---- http -------------------------------------------------------------------

const STATUS: Record<ActionError, number> = {
  'not-seated': 409,
  closed: 409,
  'already-bet': 409,
  'no-bet': 409,
  'too-late': 409,
  locked: 409,
  'bad-amount': 400,
  'bad-auto': 400,
  poor: 400,
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const fail = (error: string, status: number): Response => json({ ok: false, error }, status)

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') return {}
  const text = await req.text()
  if (text.length > 1024) throw new Error('too-big')
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function bearer(req: Request): { id: string; secret: string } | null {
  const header = req.headers.get('authorization') ?? ''
  const [id, secret] = header.replace(/^Bearer\s+/i, '').split('.')
  return id && secret ? { id, secret } : null
}

// ---- the page's sockets -------------------------------------------------------

type Sock = { account: Account | null; lastSig: string; tokens: number; at: number; ip: string }

/** Every open socket, signed in or not: the limits count them all. */
const sockets = new Set<ServerWebSocket<Sock>>()
const socketsOfIp = (ip: string): number => [...sockets].filter(s => s.data.ip === ip).length
const socketsOf = (accountId: string): ServerWebSocket<Sock>[] =>
  [...sockets].filter(s => s.data.account?.id === accountId)

/** What a player can see of a snapshot: not the clock, so a quiet table sends nothing. */
const signature = (snap: Snapshot): string =>
  JSON.stringify([snap.table, snap.players, snap.history, snap.you.name, snap.you.balance, snap.you.bet, snap.limits])

const send = (ws: ServerWebSocket<Sock>, message: unknown): void => {
  ws.send(JSON.stringify(message))
}

/** Seats the player while Claude works and sends the table's state when it has changed. */
function pushState(ws: ServerWebSocket<Sock>, force = false): void {
  const account = ws.data.account
  if (!account) return
  const now = Date.now()
  const working = game.isWorking(account.id, now)
  if (working) game.join(account, now)
  else game.touch(account, now) // a page still watching the last round keeps its seat until the round ends
  const snapshot = game.snapshot(account.id, now)
  const sig = JSON.stringify([working, snapshot && signature(snapshot), account.name, account.balance])
  if (!force && sig === ws.data.lastSig) return
  ws.data.lastSig = sig
  send(ws, { t: 'state', working, snapshot, name: account.name, balance: account.balance })
}

setInterval(() => {
  for (const ws of sockets) pushState(ws)
}, 100)

function onSocketMessage(ws: ServerWebSocket<Sock>, raw: string | Buffer): void {
  const now = Date.now()
  const d = ws.data
  d.tokens = Math.min(40, d.tokens + ((now - d.at) / 1000) * 20)
  d.at = now
  if (d.tokens < 1 || typeof raw !== 'string' || raw.length > 512) return
  d.tokens -= 1
  let m: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    m = parsed as Record<string, unknown>
  } catch {
    return
  }

  if (m.t === 'ping') {
    send(ws, { t: 'pong', c: typeof m.c === 'number' ? m.c : 0, s: now })
    return
  }

  if (m.t === 'hello') {
    if (d.account) return
    let account: Account | null = null
    let creds: { id: string; secret: string } | undefined
    if (typeof m.code === 'string') {
      const redeemed = game.redeemLink(m.code, now)
      if (redeemed) {
        account = redeemed.account
        creds = { id: account.id, secret: redeemed.secret }
      }
    } else {
      account = game.authenticate(m.id, m.secret)
    }
    if (!account) {
      send(ws, { t: 'error', error: 'unauthorized' })
      return
    }
    d.account = account
    send(ws, { t: 'welcome', name: account.name, creds })
    pushState(ws, true)
    return
  }

  const account = d.account
  if (!account) return
  if (m.t === 'bet') {
    const res = game.bet(account.id, m.amount, m.auto ?? null, now)
    send(ws, { t: 'ack', for: 'bet', ...res })
    pushState(ws, true)
  } else if (m.t === 'cashout') {
    const res = game.cashout(account.id, now)
    send(ws, { t: 'ack', for: 'cashout', ...res })
    pushState(ws, true)
  }
}

function onSocketClose(ws: ServerWebSocket<Sock>): void {
  sockets.delete(ws)
  const account = ws.data.account
  if (account && socketsOf(account.id).length === 0) game.leave(account.id, Date.now())
}

// ---- server -----------------------------------------------------------------

const server = Bun.serve<Sock>({
  port: PORT,
  hostname: HOST,
  maxRequestBodySize: 4096, // our bodies are tiny: refuse a big one before reading it
  websocket: {
    maxPayloadLength: 2048,
    open(ws) {
      ws.data = { ...ws.data, account: null, lastSig: '', tokens: 40, at: Date.now() }
      sockets.add(ws)
      // A socket that never says who it is does not get to sit here.
      setTimeout(() => {
        if (!ws.data.account) ws.close(1008, 'no hello')
      }, 10_000)
    },
    message: onSocketMessage,
    close: onSocketClose,
  },
  error() {
    return fail('server-error', 500)
  },
  async fetch(req, srv) {
    const forwarded = TRUST_PROXY ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
    const ip = clientKey(forwarded || srv.requestIP(req)?.address || 'unknown')
    if (!isAllowed(ip)) return fail('rate-limited', 429)

    const { pathname } = new URL(req.url)
    const now = Date.now()
    try {
      const isRead = req.method === 'GET' || req.method === 'HEAD'
      if (pathname === '/' && isRead) {
        return new Response(req.method === 'HEAD' ? null : indexHtml, {
          headers: { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (pathname === '/favicon.ico' && isRead) return new Response(null, { status: 204 })
      if (pathname === '/game.js' && isRead) {
        return new Response(req.method === 'HEAD' ? null : gameJs, {
          headers: { ...PAGE_HEADERS, 'content-type': 'text/javascript; charset=utf-8' },
        })
      }
      if (pathname === '/ws') {
        // Only our own page may open a socket.
        const origin = req.headers.get('origin')
        if (origin && new URL(origin).host !== req.headers.get('host')) return fail('forbidden', 403)
        if (sockets.size >= MAX_SOCKETS || socketsOfIp(ip) >= MAX_SOCKETS_PER_IP) return fail('too-many-connections', 429)
        const data: Sock = { account: null, lastSig: '', tokens: 40, at: now, ip }
        return srv.upgrade(req, { data }) ? undefined : fail('upgrade-required', 426)
      }
      if (pathname === '/health') {
        return json({ ok: true, tables: game.tables.size, accounts: game.accounts.size, pages: sockets.size })
      }
      if (pathname === '/top') return json({ ok: true, top: game.leaderboard(now) })

      const body = await readBody(req)

      // An account without a seat: what the mod uses.
      if (pathname === '/account' && req.method === 'POST') {
        let account = game.authenticate(body.id, body.secret)
        let secret: string | undefined
        if (!account) {
          if (!accountLimit.allow(ip, now)) return fail('too-many-accounts', 429)
          const made = game.createAccount(String(body.name ?? ''), now)
          if (!made) return fail('full', 503)
          account = made.account
          secret = made.secret
        } else if (typeof body.name === 'string') {
          game.rename(account, body.name)
        }
        return json({
          ok: true,
          creds: secret ? { id: account.id, secret } : undefined,
          name: account.name,
          balance: account.balance,
        })
      }

      // Kept for scripts: sit down at a table straight away.
      if (pathname === '/join' && req.method === 'POST') {
        let account = game.authenticate(body.id, body.secret)
        let secret: string | undefined
        if (!account) {
          if (!accountLimit.allow(ip, now)) return fail('too-many-accounts', 429)
          const made = game.createAccount(String(body.name ?? ''), now)
          if (!made) return fail('full', 503)
          account = made.account
          secret = made.secret
        } else if (typeof body.name === 'string') {
          game.rename(account, body.name)
        }
        game.join(account, now)
        return json({
          ok: true,
          creds: secret ? { id: account.id, secret } : undefined,
          snapshot: game.snapshot(account.id, now),
        })
      }

      const creds = bearer(req)
      const account = creds ? game.authenticate(creds.id, creds.secret) : null
      if (!account) return fail('unauthorized', 401)

      if (pathname === '/presence' && req.method === 'POST') {
        const working = body.working === true
        // Each Claude Code session reports on its own, so one finishing does not lock the others.
        const session = typeof body.session === 'string' && /^[\w.-]{1,64}$/.test(body.session) ? body.session : 'default'
        const out = game.setWorking(account.id, working, now, session)
        const open = socketsOf(account.id)
        if (out) for (const ws of open) send(ws, { t: 'locked', ...out, balance: account.balance })
        for (const ws of open) pushState(ws, true)
        return json({
          ok: true,
          pageOpen: open.length > 0,
          name: account.name,
          balance: account.balance,
          locked: out ?? undefined,
        })
      }
      if (pathname === '/link' && req.method === 'POST') {
        return json({ ok: true, code: game.createLink(account.id, now) })
      }
      if (pathname === '/state' && req.method === 'GET') {
        game.touch(account, now)
        const snapshot = game.snapshot(account.id, now)
        return snapshot ? json({ ok: true, snapshot }) : fail('not-seated', 409)
      }
      if (pathname === '/bet' && req.method === 'POST') {
        game.touch(account, now)
        const res = game.bet(account.id, body.amount, body.auto ?? null, now)
        return res.ok
          ? json({ ok: true, snapshot: game.snapshot(account.id, now) })
          : fail(res.error, STATUS[res.error])
      }
      if (pathname === '/cashout' && req.method === 'POST') {
        game.touch(account, now)
        const res = game.cashout(account.id, now)
        return res.ok
          ? json({ ok: true, multiplier: res.multiplier, payout: res.payout, snapshot: game.snapshot(account.id, now) })
          : fail(res.error, STATUS[res.error])
      }
      if (pathname === '/leave' && req.method === 'POST') {
        const out = game.leave(account.id, now)
        return json({ ok: true, ...out, balance: account.balance })
      }
      return fail('not-found', 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error'
      return fail(message === 'too-big' ? 'too-big' : 'bad-request', 400)
    }
  },
})

console.log(`idlecrash server on http://${HOST}:${server.port} (bots <= ${cfg.botPct}%)`)
