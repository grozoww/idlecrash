// IdleCrash server: one process. It runs the rounds and answers the Claude Code mod over HTTP: the mod says
// whether Claude is working (POST /presence) and plays the table (/join, /state, /bet, /cashout, /leave).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS, Game, type ActionError, type Config } from './engine'
import { HourlyLimit } from './limits'

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

// ---- server -----------------------------------------------------------------

/** What needs the mod's secret. Anything else that is not public is not here. */
const SIGNED_IN = new Set(['/presence', '/state', '/bet', '/cashout', '/leave'])

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  maxRequestBodySize: 4096, // our bodies are tiny: refuse a big one before reading it
  error() {
    return fail('server-error', 500)
  },
  async fetch(req, srv) {
    const forwarded = TRUST_PROXY ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
    const ip = forwarded || srv.requestIP(req)?.address || 'unknown'
    if (!isAllowed(ip)) return fail('rate-limited', 429)

    const { pathname } = new URL(req.url)
    const now = Date.now()
    try {
      if (pathname === '/health') {
        return json({ ok: true, tables: game.tables.size, accounts: game.accounts.size })
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

      // Find or make the account and sit down at a table: what the mod's pane starts with.
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

      if (!SIGNED_IN.has(pathname)) return fail('not-found', 404)
      const creds = bearer(req)
      const account = creds ? game.authenticate(creds.id, creds.secret) : null
      if (!account) return fail('unauthorized', 401)

      if (pathname === '/presence' && req.method === 'POST') {
        const working = body.working === true
        // Each Claude Code session reports on its own, so one finishing does not lock the others.
        const session = typeof body.session === 'string' && /^[\w.-]{1,64}$/.test(body.session) ? body.session : 'default'
        game.setWorking(account.id, working, now, session)
        return json({ ok: true, name: account.name, balance: account.balance })
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
