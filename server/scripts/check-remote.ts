// Plays one real round against a deployed server, over HTTPS and a secure WebSocket.
// Usage: bun scripts/check-remote.ts https://your-server.example
const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '')
const wsUrl = base.replace(/^http/, 'ws') + '/ws'
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed += 1
}
const post = async (path: string, body: unknown, creds?: { id: string; secret: string }) =>
  (await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(creds ? { authorization: `Bearer ${creds.id}.${creds.secret}` } : {}) },
    body: JSON.stringify(body),
  }).then(r => r.json())) as any

const health = await fetch(base + '/health').then(r => r.json() as Promise<any>)
check('health', health.ok === true)
const html = await fetch(base + '/')
check('page is served with a content security policy', html.status === 200 && !!html.headers.get('content-security-policy'))
check('page script is served', (await (await fetch(base + '/game.js')).text()).length > 5000)

const made = await post('/account', { name: 'checker' })
check('account is made', made.ok === true && !!made.creds)
const { code } = await post('/link', {}, made.creds)
check('link code is made', typeof code === 'string')

const inbox: any[] = []
const ws = new WebSocket(wsUrl)
ws.onmessage = e => inbox.push(JSON.parse(String(e.data)))
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error('socket refused'))
})
ws.send(JSON.stringify({ t: 'hello', code }))
const until = async <T>(find: () => T | undefined, ms = 15_000): Promise<T | undefined> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = find()
    if (found !== undefined) return found
    await new Promise(r => setTimeout(r, 50))
  }
  return undefined
}
check('socket says welcome', !!(await until(() => inbox.find(m => m.t === 'welcome'))))

await post('/presence', { working: true, session: 'check' }, made.creds)
// A real mod says it every 2 seconds; without that the server locks the table after 8.
const beat = setInterval(() => void post('/presence', { working: true, session: 'check' }, made.creds), 2000)
const state = await until(() => inbox.find(m => m.t === 'state' && m.working && m.snapshot))
check('table opens while "Claude works"', !!state)

const live = (): any => [...inbox].reverse().find(m => m.t === 'state')
await until(() => (live()?.snapshot?.table.phase === 'betting' && !live().snapshot.you.bet && live().snapshot.table.bettingEndsAt - live().snapshot.now > 1500 ? true : undefined), 30_000)
const before = inbox.length
ws.send(JSON.stringify({ t: 'bet', amount: 50, auto: 1.5 }))
const ack = await until(() => inbox.slice(before).find(m => m.t === 'ack' && m.for === 'bet'))
check('a bet is accepted', ack?.ok === true, JSON.stringify(ack))
const settled = await until(() => (live()?.snapshot?.table.phase === 'crashed' ? live() : undefined), 60_000)
check('the round ends', !!settled)

clearInterval(beat)
const done = await post('/presence', { working: false, session: 'check' }, made.creds)
check('finishing locks the table', done.ok === true)
check('the page is told', !!(await until(() => inbox.find(m => m.t === 'locked'), 5000)) || !!(await until(() => (live()?.working === false ? true : undefined), 5000)))
ws.close()
console.log(failed === 0 ? 'all good' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
