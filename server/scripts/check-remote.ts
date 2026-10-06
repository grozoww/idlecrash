// Plays one real round against a deployed server, over HTTPS, the way the mod does.
// It also checks that the server runs the version and the protocol of the checkout this is run from: after a deploy
// of a commit, that is how we know the commit is what is live.
// Usage: bun scripts/check-remote.ts https://your-server.example
import pkg from '../../package.json'
import { PROTOCOL } from '../../shared/protocol'

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '')
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed += 1
}
type Creds = { id: string; secret: string }
const headers = (creds?: Creds): Record<string, string> => ({
  'content-type': 'application/json',
  ...(creds ? { authorization: `Bearer ${creds.id}.${creds.secret}` } : {}),
})
const post = async (path: string, body: unknown, creds?: Creds) =>
  (await fetch(base + path, { method: 'POST', headers: headers(creds), body: JSON.stringify(body) }).then(r => r.json())) as any
const state = async (creds: Creds) => (await fetch(base + '/state', { headers: headers(creds) }).then(r => r.json())) as any

/** Asks the table until `want` is true of the snapshot, or gives up. */
async function until(creds: Creds, want: (snapshot: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const snapshot = (await state(creds)).snapshot
    if (snapshot && want(snapshot)) return snapshot
    await new Promise(r => setTimeout(r, 150))
  }
  return undefined
}

const health = await fetch(base + '/health').then(r => r.json() as Promise<any>)
check('health', health.ok === true)
check(`the server runs version ${pkg.version}`, health.version === pkg.version, `it says ${health.version}`)
check(`and speaks protocol ${PROTOCOL}`, health.protocol === PROTOCOL, `it says ${health.protocol}`)
check('there is no page, only the API', (await fetch(base + '/')).status === 404)

const made = await post('/account', { name: 'checker' })
check('account is made', made.ok === true && !!made.creds)
const creds = made.creds as Creds
const joined = await post('/join', { id: creds.id, secret: creds.secret })
check('a seat at a table', joined.ok === true && !!joined.snapshot)
check('betting is locked while "Claude" is idle', (await post('/bet', { amount: 50, auto: null }, creds)).error === 'locked')

await post('/presence', { working: true, session: 'check' }, creds)
// A real mod says it every 2 seconds; without that the server locks the table after 8.
const beat = setInterval(() => void post('/presence', { working: true, session: 'check' }, creds), 2000)
const betting = await until(creds, s => s.table.phase === 'betting' && !s.you.bet && s.table.bettingEndsAt - s.now > 1500, 30_000)
check('the table opens while "Claude works"', !!betting)

const bet = await post('/bet', { amount: 50, auto: 1.5 }, creds)
check('a bet is accepted', bet.ok === true, JSON.stringify(bet))
const crashed = await until(creds, s => s.table.phase === 'crashed', 60_000)
check('the round ends', !!crashed)

clearInterval(beat)
const done = await post('/presence', { working: false, session: 'check' }, creds)
check('finishing is accepted', done.ok === true)
check('and then betting is locked again', (await post('/bet', { amount: 50, auto: null }, creds)).error === 'locked')
await post('/leave', {}, creds)
console.log(failed === 0 ? 'all good' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
