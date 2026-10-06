// A server and a mod of different ages: the server says its version and protocol, and tells a mod it no longer serves to update.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../../package.json'
import { PROTOCOL, PROTOCOL_HEADER } from '../../shared/protocol'

const PORT = 19_000 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'idlecrash-skew-'))
let child: ReturnType<typeof Bun.spawn>

// A server that no longer serves a mod below protocol 2, and says it speaks PROTOCOL.
beforeAll(async () => {
  child = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, MIN_MOD_PROTOCOL: '2' },
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

const call = async (path: string, protocol?: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(protocol === undefined ? {} : { [PROTOCOL_HEADER]: protocol }) },
    body: '{}',
  })
  return { status: res.status, body: await res.json() }
}

describe('the server says how old it is', () => {
  test('/health has the version of this commit and its protocol', async () => {
    const health = (await fetch(`${BASE}/health`).then(r => r.json())) as any
    expect(health).toMatchObject({ ok: true, version: pkg.version, protocol: PROTOCOL })
  })

  test('every reply carries the protocol, errors too', async () => {
    const top = (await fetch(`${BASE}/top`).then(r => r.json())) as any
    expect(top.protocol).toBe(PROTOCOL)
    expect((await call('/state', '2')).body.protocol).toBe(PROTOCOL) // a 401: the protocol is still there
  })
})

describe('a mod the server no longer serves', () => {
  test('one with no header (from before the protocol) or an older one is told to update', async () => {
    for (const protocol of [undefined, '0', '1', 'junk']) {
      for (const path of ['/account', '/join', '/presence', '/state', '/bet', '/cashout', '/leave']) {
        const res = await call(path, protocol)
        expect(res.status).toBe(426)
        expect(res.body).toMatchObject({ ok: false, error: 'mod-too-old', protocol: PROTOCOL })
      }
    }
  })

  test('one that is new enough is served', async () => {
    const made = await call('/account', '2')
    expect(made.status).toBe(200)
    expect(made.body.ok).toBe(true)
    expect((await call('/state', '3')).status).toBe(401) // past the age check, then it wants a secret
  })

  test('what needs no mod stays open, and a made-up path is still not found', async () => {
    expect((await fetch(`${BASE}/health`)).status).toBe(200)
    expect((await fetch(`${BASE}/top`)).status).toBe(200)
    expect((await call('/nothing-here')).status).toBe(404)
  })
})
