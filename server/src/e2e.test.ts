// Starts the real server in a child process with short rounds and plays through
// HTTP and a WebSocket, the way the mod and the page do.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18_700 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'idlecrash-e2e-'))
let child: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  child = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BETTING_MS: '700', CRASHED_MS: '300', MAX_SOCKETS_PER_IP: '6', ACCOUNTS_PER_IP_HOUR: '1000' },
    stdout: 'ignore',
    stderr: 'ignore',
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

async function post(path: string, body: unknown = {}, creds?: Creds): Promise<any> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(creds ? { authorization: `Bearer ${creds.id}.${creds.secret}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, ...((await res.json()) as object) }
}

/** A page: a WebSocket that remembers what the server sent. */
class Page {
  messages: any[] = []
  private socket: WebSocket
  ready: Promise<void>

  constructor(headers?: Record<string, string>) {
    this.socket = new (WebSocket as any)(`ws://127.0.0.1:${PORT}/ws`, headers ? { headers } : undefined)
    this.socket.onmessage = e => this.messages.push(JSON.parse(String(e.data)))
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve()
      this.socket.onerror = () => reject(new Error('socket refused'))
    })
  }

  send(m: unknown): void {
    this.socket.send(typeof m === 'string' ? m : JSON.stringify(m))
  }

  close(): void {
    this.socket.close()
  }

  async until<T>(find: (messages: any[]) => T | undefined, ms = 4000): Promise<T> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const found = find(this.messages)
      if (found !== undefined) return found
      await Bun.sleep(20)
    }
    throw new Error(`timed out; got ${JSON.stringify(this.messages.slice(-3)).slice(0, 400)}`)
  }

  last(type: string): any {
    return [...this.messages].reverse().find(m => m.t === type)
  }
}

async function player(name: string): Promise<{ creds: Creds; page: Page }> {
  const made = await post('/account', { name })
  const creds = made.creds as Creds
  const { code } = await post('/link', {}, creds)
  const page = new Page()
  await page.ready
  page.send({ t: 'hello', code })
  await page.until(ms => ms.find(m => m.t === 'welcome'))
  return { creds, page }
}

describe('the page', () => {
  test('is served with a strict content security policy, and its script bundles', async () => {
    const html = await fetch(BASE + '/')
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('IDLECRASH')
    expect(html.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await fetch(BASE + '/', { method: 'HEAD' })).status).toBe(200) // monitors ask with HEAD
    const js = await (await fetch(BASE + '/game.js')).text()
    expect(js.length).toBeGreaterThan(5000)
    expect(js).toContain('hello')
  })
})

describe('linking', () => {
  test('a code opens a page with a key of its own, once', async () => {
    const made = await post('/account', { name: 'Linker' })
    const { code } = await post('/link', {}, made.creds)
    const a = new Page()
    await a.ready
    a.send({ t: 'hello', code })
    const welcome = await a.until(ms => ms.find(m => m.t === 'welcome'))
    expect(welcome.creds.id).toBe(made.creds.id)
    expect(welcome.creds.secret).not.toBe(made.creds.secret) // the mod's secret stays with the mod
    a.close()

    const b = new Page()
    await b.ready
    b.send({ t: 'hello', code }) // the same code again
    expect((await b.until(ms => ms.find(m => m.t === 'error'))).error).toBe('unauthorized')

    const c = new Page()
    await c.ready
    c.send({ t: 'hello', id: welcome.creds.id, secret: welcome.creds.secret }) // the page's own key works
    await c.until(ms => ms.find(m => m.t === 'welcome'))
    c.close()
    b.close()
  })

  test('a page from another site is refused', async () => {
    const page = new Page({ Origin: 'http://evil.example' })
    await expect(page.ready).rejects.toThrow()
  })

  test('the mod\'s endpoints need its secret', async () => {
    expect((await post('/presence', { working: true })).status).toBe(401)
    expect((await post('/link', {}, { id: 'nobody', secret: 'x' })).status).toBe(401)
  })
})

describe('a game', () => {
  test('betting is locked until Claude works, then open, then locked again', async () => {
    const { creds, page } = await player('Locke')
    const idle = await page.until(ms => ms.find(m => m.t === 'state'))
    expect(idle.working).toBe(false)
    expect(idle.snapshot).toBeNull()

    page.send({ t: 'bet', amount: 50, auto: null })
    expect((await page.until(ms => ms.find(m => m.t === 'ack'))).error).toBe('not-seated')

    const beat = await post('/presence', { working: true, session: 's1' }, creds)
    expect(beat.pageOpen).toBe(true)
    const working = await page.until(ms => ms.find(m => m.t === 'state' && m.working && m.snapshot))
    expect(working.snapshot.table.phase).toBeDefined()

    // bet while the betting phase is open; rounds are short here, so try each round
    let bet: any
    for (let i = 0; i < 6 && !bet?.ok; i++) {
      await page.until(ms => {
        const s = page.last('state')
        return s?.snapshot?.table.phase === 'betting' && !s.snapshot.you.bet && s.snapshot.table.bettingEndsAt - s.snapshot.now > 250 ? true : undefined
      })
      const before = page.messages.length
      page.send({ t: 'bet', amount: 50, auto: null })
      bet = await page.until(ms => ms.slice(before).find(m => m.t === 'ack' && m.for === 'bet'))
    }
    expect(bet.ok).toBe(true)
    const placed = await page.until(ms => {
      const s = page.last('state')
      return s?.snapshot?.you.bet ? s : undefined
    })
    expect(placed.balance).toBe(950)

    // Claude finishes while the bet is open: it is settled and the page is told
    const done = await post('/presence', { working: false, session: 's1' }, creds)
    expect(done.locked.refunded + done.locked.cashed).toBeGreaterThanOrEqual(0)
    const locked = await page.until(ms => ms.find(m => m.t === 'locked'))
    expect(locked.balance).toBeGreaterThan(0)
    const after = await page.until(ms => {
      const s = page.last('state')
      return s && !s.working ? s : undefined
    })
    expect(after.snapshot).toBeNull()
    page.close()
  })

  test('a manual cash-out pays the stake times the multiplier', async () => {
    const { creds, page } = await player('Casher')
    await post('/presence', { working: true, session: 's1' }, creds)
    let won: any
    for (let round = 0; round < 8 && !won; round++) {
      await page.until(ms => {
        const s = page.last('state')
        return s?.snapshot?.table.phase === 'betting' && !s.snapshot.you.bet && s.snapshot.table.bettingEndsAt - s.snapshot.now > 250 ? true : undefined
      })
      page.send({ t: 'bet', amount: 100, auto: null })
      await page.until(ms => {
        const s = page.last('state')
        return s?.snapshot?.table.phase === 'running' && s.snapshot.you.bet ? true : undefined
      })
      const before = page.messages.length
      page.send({ t: 'cashout' })
      const ack = await page.until(ms => ms.slice(before).find(m => m.t === 'ack' && m.for === 'cashout'))
      if (ack.ok) won = ack
    }
    expect(won).toBeDefined()
    expect(won.payout).toBe(Math.floor((100 * Math.round(won.multiplier * 100)) / 100))
    expect(won.payout).toBeGreaterThanOrEqual(100)
    page.close()
  })

  test('two Claude sessions: one finishing does not lock the page', async () => {
    const { creds, page } = await player('Twice')
    await post('/presence', { working: true, session: 'a' }, creds)
    await post('/presence', { working: true, session: 'b' }, creds)
    await page.until(ms => ms.find(m => m.t === 'state' && m.working))
    await post('/presence', { working: false, session: 'a' }, creds)
    await Bun.sleep(400)
    expect(page.last('state').working).toBe(true)
    await post('/presence', { working: false, session: 'b' }, creds)
    await page.until(ms => {
      const s = page.last('state')
      return s && !s.working ? true : undefined
    })
    page.close()
  })

  test('without heartbeats the table locks by itself', async () => {
    const { creds, page } = await player('Quiet')
    await post('/presence', { working: true, session: 's1' }, creds)
    await page.until(ms => ms.find(m => m.t === 'state' && m.working))
    await page.until(ms => {
      const s = page.last('state')
      return s && !s.working ? true : undefined
    }, 12_000)
    page.close()
  }, 15_000)

  test('closing the page leaves the table', async () => {
    const { creds, page } = await player('Leaver')
    await post('/presence', { working: true, session: 's1' }, creds)
    await page.until(ms => ms.find(m => m.t === 'state' && m.snapshot))
    const before = ((await (await fetch(BASE + '/health')).json()) as any).pages
    page.close()
    await Bun.sleep(300)
    const after = ((await (await fetch(BASE + '/health')).json()) as any).pages
    expect(after).toBe(before - 1)
    await post('/presence', { working: false, session: 's1' }, creds)
  })
})

describe('abuse', () => {
  test('one address cannot hold more sockets than the cap, signed in or not', async () => {
    const held: Page[] = []
    for (let i = 0; i < 6; i++) {
      const page = new Page()
      await page.ready
      held.push(page)
    }
    const seventh = new Page()
    await expect(seventh.ready).rejects.toThrow()
    for (const page of held) page.close()
    await Bun.sleep(200)
    const again = new Page() // the room is free again
    await again.ready
    again.close()
  })

  test('a body bigger than a request ever needs is refused', async () => {
    const res = await fetch(BASE + '/account', { method: 'POST', body: 'x'.repeat(10_000) })
    expect([400, 413]).toContain(res.status)
  })

  test('messages that are not messages do nothing', async () => {
    const { page } = await player('Fuzzer')
    for (const junk of ['{', '[]', 'null', '"x"', JSON.stringify({ t: 'bet' }), JSON.stringify({ t: 'zzz' }), 'x'.repeat(600)]) {
      page.send(junk)
    }
    page.send({ t: 'ping', c: 1 })
    expect((await page.until(ms => ms.find(m => m.t === 'pong'))).c).toBe(1)
    page.close()
  })
})
