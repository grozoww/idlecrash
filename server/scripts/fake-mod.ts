// Stands in for the Claude Code mod while you work on the page: makes an account,
// says "Claude is working" every 2 seconds, and prints the link that opens the page.
// Usage: bun scripts/fake-mod.ts [http://localhost:8787] [seconds of work, default forever]
const base = process.argv[2] ?? 'http://localhost:8787'
const workFor = Number(process.argv[3] ?? Infinity)

const call = async (creds: { id: string; secret: string } | null, path: string, body?: unknown) =>
  (await (await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(creds ? { authorization: `Bearer ${creds.id}.${creds.secret}` } : {}) },
    body: JSON.stringify(body ?? {}),
  })).json()) as any

const made = await call(null, '/account', { name: 'Maverick' })
const creds = made.creds
console.log(`account ${made.name}, balance ${made.balance}`)
const { code } = await call(creds, '/link')
console.log(`open: ${base}/?c=${code}`)

const t0 = Date.now()
while ((Date.now() - t0) / 1000 < workFor) {
  const r = await call(creds, '/presence', { working: true })
  if (!r.ok) throw new Error(JSON.stringify(r))
  await new Promise(r => setTimeout(r, 2000))
}
const done = await call(creds, '/presence', { working: false })
console.log('Claude "finished":', JSON.stringify(done.locked ?? {}), 'balance', done.balance)
