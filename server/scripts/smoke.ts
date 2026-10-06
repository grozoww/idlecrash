// Plays a few rounds against a running server with several fake players.
// Usage: bun scripts/smoke.ts [http://localhost:8787] [players]
const base = process.argv[2] ?? 'http://localhost:8787'
const count = Number(process.argv[3] ?? 4)

type Client = { name: string; id: string; secret: string }
const call = async (c: Client | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(c ? { authorization: `Bearer ${c.id}.${c.secret}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as any }
}

const clients: Client[] = []
for (let i = 0; i < count; i++) {
  const { json } = await call(null, 'POST', '/join', { name: `smoke${i}` })
  clients.push({ name: `smoke${i}`, id: json.creds.id, secret: json.creds.secret })
}
const beat = () => Promise.all(clients.map(c => call(c, 'POST', '/presence', { working: true, session: 'smoke' })))
await beat() // betting is open only while Claude "works"
console.log(`joined ${clients.length}; table ${(await call(clients[0]!, 'GET', '/state')).json.snapshot.table.id}`)
let lastBeat = Date.now()

let wins = 0
let losses = 0
const t0 = Date.now()
while (Date.now() - t0 < 50_000) {
  if (Date.now() - lastBeat > 2000) {
    lastBeat = Date.now()
    await beat()
  }
  for (const [i, c] of clients.entries()) {
    const { json } = await call(c, 'GET', '/state')
    const s = json.snapshot
    if (!s) continue
    if (s.table.phase === 'betting' && !s.you.bet && s.table.bettingEndsAt - s.now > 500) {
      await call(c, 'POST', '/bet', { amount: 50, auto: i % 2 === 0 ? 1.5 : null })
    }
    if (s.table.phase === 'running' && s.you.bet && s.you.bet.cash === null && i % 2 === 1) {
      const m = Math.floor(100 * Math.exp((s.growth * (s.now - s.table.runStartedAt)) / 1000)) / 100
      if (m >= 1.4) {
        const r = await call(c, 'POST', '/cashout')
        if (r.json.ok) wins++
        else losses++
      }
    }
  }
  await new Promise(r => setTimeout(r, 400))
}
const last = (await call(clients[0]!, 'GET', '/state')).json.snapshot
console.log('round', last.table.round, 'history', last.history.join(' '))
console.log('players', last.players.map((p: any) => `${p.bot ? '[bot]' : ''}${p.name}:${p.bet}${p.cash ? '@' + p.cash : ''}`).join(', '))
console.log('manual cashouts ok/late', wins, losses)
console.log('balances', (await Promise.all(clients.map(c => call(c, 'GET', '/state')))).map(r => r.json.snapshot.you.balance).join(' '))
for (const c of clients) await call(c, 'POST', '/leave')
console.log('top', JSON.stringify((await call(null, 'GET', '/top')).json.top.slice(0, 3)))
