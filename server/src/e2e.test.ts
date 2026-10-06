// Starts the real server in a child process with short rounds and plays through HTTP, the way the mod does.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setDefaultTimeout(30_000) // a round takes a few seconds, even a short one

const PORT = 18_700 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'idlecrash-e2e-'))
let child: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  child = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BETTING_MS: '700', CRASHED_MS: '300', MAX_MULTIPLIER: '2', ACCOUNTS_PER_IP_HOUR: '1000' },
    stdout: 'ignore',
    stderr: process.env.E2E_LOGS ? 'inherit' : 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return
    } catch {
      // not up yet
    }
    await Bun.sleep(100)
  }
  throw new Error('server did not start')
})

afterAll(() => {
  child.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

type Creds = { id: string; secret: string }

const auth = (creds?: Creds): Record<string, string> => (creds ? { authorization: `Bearer ${creds.id}.${creds.secret}` } : {})

async function post(path: string, body: unknown = {}, creds?: Creds): Promise<any> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(creds) },
    body: JSON.stringify(body),
  })
  return { status: res.status, ...((await res.json()) as object) }
}

async function get(path: string, creds?: Creds): Promise<any> {
  const res = await fetch(BASE + path, { headers: auth(creds) })
  return { status: res.status, ...((await res.json()) as object) }
}

/** An account that sits at a table, the way the mod's pane starts. */
async function player(name: string): Promise<Creds> {
  const made = await post('/account', { name })
  const creds = made.creds as Creds
  await post('/join', { id: creds.id, secret: creds.secret })
  return creds
}

/** Asks the table until `want` is true of the snapshot, or throws. */
async function until(creds: Creds, want: (snapshot: any) => boolean, ms = 8000): Promise<any> {
  const end = Date.now() + ms
  let last: any
  while (Date.now() < end) {
    last = await get('/state', creds)
    if (last.snapshot && want(last.snapshot)) return last.snapshot
    await Bun.sleep(30)
  }
  throw new Error(`timed out; the table said ${JSON.stringify(last).slice(0, 300)}`)
}

/** The betting phase with room left to bet in; rounds are short here. */
const canBet = (s: any): boolean => s.table.phase === 'betting' && !s.you.bet && s.table.bettingEndsAt - s.now > 250

describe('what the server answers', () => {
  test('the mod\'s endpoints need its secret', async () => {
    expect((await post('/presence', { working: true })).status).toBe(401)
    expect((await get('/state')).status).toBe(401)
    expect((await post('/bet', { amount: 50 }, { id: 'nobody', secret: 'x' })).status).toBe(401)
  })

  test('there is no page: it was a browser version, and it is gone', async () => {
    for (const path of ['/', '/game.js', '/favicon.ico', '/ws', '/link']) {
      expect((await fetch(BASE + path)).status).toBe(404)
      expect((await fetch(BASE + path, { method: 'POST', body: '{}' })).status).toBe(404)
    }
  })

  test('health and the board are public', async () => {
    const health = await get('/health')
    expect(health).toMatchObject({ ok: true })
    expect(health.pages).toBeUndefined()
    expect((await get('/top')).top).toBeInstanceOf(Array)
  })
})

describe('a game', () => {
  test('betting is locked until Claude works; then the bet stays in its round after Claude stops', async () => {
    const creds = await player('Locke')
    expect((await post('/bet', { amount: 50, auto: null }, creds)).error).toBe('locked')

    await post('/presence', { working: true, session: 's1' }, creds)
    let bet: any
    for (let i = 0; i < 6 && !bet?.ok; i++) {
      await until(creds, canBet)
      bet = await post('/bet', { amount: 50, auto: null }, creds)
    }
    expect(bet.ok).toBe(true)
    expect((await get('/state', creds)).snapshot.you.balance).toBe(950)

    // Claude finishes while the bet is open: nothing is settled for the player.
    const done = await post('/presence', { working: false, session: 's1' }, creds)
    expect(done).toMatchObject({ ok: true, balance: 950 })
    expect(done.locked).toBeUndefined()
    const after = (await get('/state', creds)).snapshot
    expect(after.you.balance).toBe(950) // not refunded
    expect((await post('/bet', { amount: 50, auto: null }, creds)).error).toBe('locked') // and nothing new can be bet

    // The cash-out needs no Claude: it pays while the plane flies, and says it is too late after the crash.
    const cashed = await post('/cashout', {}, creds)
    if (cashed.ok) expect(cashed.payout).toBeGreaterThanOrEqual(50)
    else expect(['too-late', 'closed', 'no-bet']).toContain(cashed.error)

    // When that round is over, the table goes.
    const end = Date.now() + 8000
    let seated = true
    while (seated && Date.now() < end) {
      seated = (await get('/state', creds)).status === 200
      await Bun.sleep(40)
    }
    expect(seated).toBe(false)
  })

  test('a manual cash-out pays the stake times the multiplier', async () => {
    const creds = await player('Casher')
    await post('/presence', { working: true, session: 's1' }, creds)
    let won: any
    for (let round = 0; round < 8 && !won; round++) {
      await until(creds, canBet)
      await post('/bet', { amount: 100, auto: null }, creds)
      await until(creds, s => s.table.phase === 'running' && !!s.you.bet)
      const res = await post('/cashout', {}, creds)
      if (res.ok) won = res
    }
    expect(won).toBeDefined()
    expect(won.payout).toBe(Math.floor((100 * Math.round(won.multiplier * 100)) / 100))
    expect(won.payout).toBeGreaterThanOrEqual(100)
    await post('/presence', { working: false, session: 's1' }, creds)
  })

  test('without heartbeats the table locks by itself', async () => {
    const creds = await player('Quiet')
    await post('/presence', { working: true, session: 's1' }, creds)
    expect((await post('/bet', { amount: 50, auto: null }, creds)).error).not.toBe('locked')
    const end = Date.now() + 12_000
    let error = ''
    while (error !== 'locked' && Date.now() < end) {
      await Bun.sleep(300)
      error = (await post('/bet', { amount: 50, auto: null }, creds)).error ?? ''
    }
    expect(error).toBe('locked')
  }, 15_000)

  test('leaving gives the seat up, and a bet that is open is settled at once', async () => {
    const creds = await player('Leaver')
    await post('/presence', { working: true, session: 's1' }, creds)
    await until(creds, canBet)
    await post('/bet', { amount: 50, auto: null }, creds)
    const left = await post('/leave', {}, creds)
    expect(left.ok).toBe(true)
    expect((await get('/state', creds)).status).toBe(409) // not seated any more
    await post('/presence', { working: false, session: 's1' }, creds)
  })
})

describe('abuse', () => {
  test('a body bigger than a request ever needs is refused', async () => {
    const res = await fetch(BASE + '/account', { method: 'POST', body: 'x'.repeat(10_000) })
    expect([400, 413]).toContain(res.status)
  })

  test('requests that are not requests do nothing', async () => {
    const creds = await player('Fuzzer')
    for (const body of ['{', '[]', 'null', '"x"', JSON.stringify({ amount: 'lots' }), JSON.stringify({ zzz: 1 })]) {
      const res = await fetch(BASE + '/bet', { method: 'POST', headers: { 'content-type': 'application/json', ...auth(creds) }, body })
      expect(res.status).toBeLessThan(500)
    }
    expect((await get('/health')).ok).toBe(true) // and the server is still there
  })
})
