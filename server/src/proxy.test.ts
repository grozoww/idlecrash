// Starts the server the way it runs on the machine, behind Caddy (TRUST_PROXY=1), and checks
// that the new-account limit counts a client the way clientKey says: an IPv6 /64 is one client.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18_900 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'idlecrash-proxy-'))
let child: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  child = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, TRUST_PROXY: '1', ACCOUNTS_PER_IP_HOUR: '2' },
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

/** What a script does to get round a per-IP limit: ask for an account from a new address each time. */
const newAccountFrom = async (ip: string): Promise<number> =>
  (await fetch(`${BASE}/account`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: '{}' })).status

test('new accounts are limited per IPv4 address', async () => {
  expect([await newAccountFrom('198.51.100.1'), await newAccountFrom('198.51.100.1'), await newAccountFrom('198.51.100.1')]).toEqual([200, 200, 429])
  expect(await newAccountFrom('198.51.100.2')).toBe(200) // another address has its own count
})

test('new accounts are limited per IPv6 /64, not per address', async () => {
  const statuses = [
    await newAccountFrom('2001:db8:aa:1::1'),
    await newAccountFrom('2001:db8:aa:1:1234:5678:9abc:def0'),
    await newAccountFrom('2001:db8:aa:1::ffff'), // the third address of the same /64
  ]
  expect(statuses).toEqual([200, 200, 429])
  expect(await newAccountFrom('2001:db8:aa:2::1')).toBe(200) // the next /64 has its own count
})
