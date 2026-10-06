// The IdleCrash page. It shows the table the server pushes over a WebSocket,
// draws the pixel-art scene on a canvas from the same code the mod ships, and
// sends bets and cash-outs back. Every number on screen comes from the server.
import { AUTOS, STAKES, cleanName, fmt, parseSnapshot, payoutFor, seconds, sign, times } from '../../shared/lib'
import { PALETTE, drawScene, sceneInputFor } from '../../shared/scene'
import type { SceneProps } from '../../shared/scene'
import type { Snapshot } from '../../shared/types'

const W = 64
const H = 32

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const el = {
  pill: byId('pill'),
  balance: byId('balance'),
  delta: byId('delta'),
  stage: byId('stage'),
  canvas: byId<HTMLCanvasElement>('scene'),
  big: byId('big'),
  sub: byId('sub'),
  lock: byId('lock'),
  watch: byId('watch'),
  bet: byId<HTMLButtonElement>('bet'),
  cash: byId<HTMLButtonElement>('cash'),
  stakes: byId('stakes'),
  auto: byId<HTMLButtonElement>('auto'),
  rebet: byId<HTMLButtonElement>('rebet'),
  note: byId('note'),
  players: byId('players'),
  tableTitle: byId('tableTitle'),
  history: byId('history'),
}

const ERRORS: Record<string, string> = {
  closed: 'Bets are closed this round',
  'already-bet': 'You already have a bet',
  'no-bet': 'No open bet',
  'too-late': 'Too late, it crashed',
  'bad-amount': 'That stake is not allowed',
  'bad-auto': 'That auto cash-out is not allowed',
  poor: 'Not enough tokens',
  'not-seated': 'Taking your seat, try again',
  locked: 'Claude is not working, betting is locked',
}

// ---- what the player picked ----------------------------------------------------

type Settings = { stake: number; auto: number | null; rebet: boolean }
const SETTINGS_KEY = 'idlecrash.settings'
const CREDS_KEY = 'idlecrash.creds'

function readStore<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function writeStore(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: the page works, it just forgets.
  }
}

const settings: Settings = { stake: 50, auto: 2, rebet: false, ...(readStore<Partial<Settings>>(SETTINGS_KEY) ?? {}) }
if (!STAKES.includes(settings.stake)) settings.stake = 50
const saveSettings = (): void => writeStore(SETTINGS_KEY, settings)

// ---- state ------------------------------------------------------------------------

let socket: WebSocket | null = null
let isOnline = false
let isWorking = false
let hasCreds = false
let snap: Snapshot | null = null
let balance = 0
let balanceAtStart: number | null = null
let offset = 0 // the server's clock minus ours
let bestRtt = Infinity
let summary = ''
let note = ''
let noteTimer = 0
let rebetRound = -1
let notedKey = ''
let retry = 1000

const serverNow = (): number => Date.now() + offset

/** Touches the page only when the text really changed. */
function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

function setNote(text: string, ms = 4500): void {
  note = text
  el.note.textContent = text
  window.clearTimeout(noteTimer)
  if (text) noteTimer = window.setTimeout(() => setNote(''), ms)
}

function send(message: Record<string, unknown>): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

// ---- connection ---------------------------------------------------------------------

function hello(): void {
  const url = new URL(location.href)
  const code = url.searchParams.get('c')
  const creds = readStore<{ id: string; secret: string }>(CREDS_KEY)
  if (code) {
    // The code works once: take it out of the address bar and the history.
    url.searchParams.delete('c')
    history.replaceState(null, '', url.pathname + url.search)
    send({ t: 'hello', code })
  } else if (creds) {
    send({ t: 'hello', id: creds.id, secret: creds.secret })
  } else {
    hasCreds = false
    renderStatic()
  }
}

function connect(): void {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  socket.onopen = () => {
    retry = 1000
    hello()
    ping()
  }
  socket.onmessage = event => {
    try {
      handle(JSON.parse(String(event.data)))
    } catch {
      // A message we cannot read is ignored.
    }
  }
  socket.onclose = () => {
    isOnline = false
    renderStatic()
    window.setTimeout(connect, retry)
    retry = Math.min(10_000, retry * 1.7)
  }
}

function ping(): void {
  send({ t: 'ping', c: Date.now() })
}
window.setInterval(ping, 4000)

function handle(m: Record<string, any>): void {
  if (m.t === 'pong') {
    const now = Date.now()
    const rtt = now - Number(m.c)
    if (rtt >= 0 && rtt <= bestRtt + 40) {
      bestRtt = Math.min(bestRtt, rtt)
      offset = Number(m.s) - (Number(m.c) + now) / 2
    }
  } else if (m.t === 'welcome') {
    isOnline = true
    hasCreds = true
    if (m.creds?.id && m.creds?.secret) writeStore(CREDS_KEY, { id: String(m.creds.id), secret: String(m.creds.secret) })
    renderStatic()
  } else if (m.t === 'error' && m.error === 'unauthorized') {
    writeStore(CREDS_KEY, null)
    hasCreds = false
    isOnline = false
    renderStatic()
  } else if (m.t === 'state') {
    onState(m)
  } else if (m.t === 'ack') {
    if (m.ok === false) setNote(ERRORS[String(m.error)] ?? 'Refused')
  } else if (m.t === 'locked') {
    const parts = [`Claude finished. Balance ${fmt(Number(m.balance) || 0)}.`]
    if (Number(m.cashed) > 0) parts.push(`Your open bet was cashed out for you (+${fmt(Number(m.cashed))}).`)
    if (Number(m.refunded) > 0) parts.push(`Your open bet was refunded (${fmt(Number(m.refunded))}).`)
    summary = parts.join(' ')
    renderStatic()
  }
}

function onState(m: Record<string, any>): void {
  const before = snap
  const wasWorking = isWorking
  isWorking = m.working === true
  balance = Number(m.balance) || 0
  // After Claude stops the server keeps the table on screen until the round is over.
  snap = parseSnapshot(m.snapshot)
  if (isWorking && !wasWorking) {
    balanceAtStart = balance
    summary = ''
    notedKey = ''
    rebetRound = -1
  }
  if (snap) noteChanges(before, snap)
  maybeRebet()
  renderStatic()
}

/** Says what just happened to the player's own bet. */
function noteChanges(before: Snapshot | null, now: Snapshot): void {
  const mine = now.you.bet
  const round = now.table.round
  if (mine && mine.cash !== null && notedKey !== `${round}:won`) {
    notedKey = `${round}:won`
    setNote(`Won ${fmt(mine.payout)} at ${times(mine.cash)} (profit ${sign(mine.payout - mine.amount)})`)
  } else if (mine && mine.cash === null && now.table.phase === 'crashed' && notedKey !== `${round}:lost` && before) {
    notedKey = `${round}:lost`
    setNote(`Crashed at ${times(now.table.crashPoint ?? 1)}. Lost ${fmt(mine.amount)}`)
  }
}

function maybeRebet(): void {
  if (!settings.rebet || !snap || !isWorking) return
  const left = snap.table.bettingEndsAt - serverNow()
  if (snap.table.phase === 'betting' && !snap.you.bet && snap.table.round !== rebetRound && left > 600) {
    rebetRound = snap.table.round
    placeBet()
  }
}

// ---- actions ------------------------------------------------------------------------

function placeBet(): void {
  send({ t: 'bet', amount: settings.stake, auto: settings.auto })
}

function cashOut(): void {
  send({ t: 'cashout' })
}

function primary(): void {
  if (!snap) return
  if (snap.table.phase === 'betting' && !snap.you.bet) placeBet()
  else if (snap.table.phase === 'running' && snap.you.bet && snap.you.bet.cash === null) cashOut()
}

el.bet.addEventListener('click', placeBet)
el.cash.addEventListener('click', cashOut)
el.auto.addEventListener('click', () => {
  settings.auto = AUTOS[(AUTOS.indexOf(settings.auto) + 1) % AUTOS.length] ?? null
  saveSettings()
  renderStatic()
})
el.rebet.addEventListener('click', () => {
  settings.rebet = !settings.rebet
  saveSettings()
  maybeRebet()
  renderStatic()
})

STAKES.forEach((stake, i) => {
  const button = document.createElement('button')
  button.textContent = fmt(stake)
  button.dataset.stake = String(stake)
  const key = document.createElement('kbd')
  key.textContent = String(i + 1)
  button.append(key)
  button.addEventListener('click', () => {
    settings.stake = stake
    saveSettings()
    renderStatic()
  })
  el.stakes.append(button)
})

window.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  const key = event.key.toLowerCase()
  if (key === 'b') placeBet()
  else if (key === 'c') cashOut()
  else if (key === ' ') {
    event.preventDefault()
    primary()
  } else if (key >= '1' && key <= String(STAKES.length)) {
    settings.stake = STAKES[Number(key) - 1]!
    saveSettings()
    renderStatic()
  } else if (key === 'x') el.auto.click()
  else if (key === 'r') el.rebet.click()
})

// ---- drawing the screen ---------------------------------------------------------------

const RGB = PALETTE.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)))
const context = el.canvas.getContext('2d')!
const image = context.createImageData(W, H)

function paint(px: Uint8Array): void {
  for (let i = 0; i < px.length; i++) {
    const [r, g, b] = RGB[px[i]!]!
    image.data[i * 4] = r!
    image.data[i * 4 + 1] = g!
    image.data[i * 4 + 2] = b!
    image.data[i * 4 + 3] = 255
  }
  context.putImageData(image, 0, 0)
}

/** Whole-number zoom, so every pixel of the scene is the same size on screen. */
function fit(): void {
  const room = Math.min(el.stage.clientWidth - 20, 736)
  const scale = Math.max(1, Math.floor(room / W))
  el.canvas.style.width = `${W * scale}px`
  el.canvas.style.height = `${H * scale}px`
}
window.addEventListener('resize', fit)

function sceneProps(): SceneProps {
  const t = snap?.table
  return {
    phase: t?.phase ?? 'betting',
    round: t?.round ?? 1,
    columns: W,
    rows: H / 2,
    growth: snap?.growth ?? 0.12,
    runStartedAt: t?.runStartedAt ?? null,
    crashedAt: t?.crashedAt ?? null,
    crashPoint: t?.crashPoint ?? null,
    bettingEndsAt: t?.bettingEndsAt ?? 0,
    serverNow: serverNow(),
    stake: 0,
  }
}

const liveBet = (): Snapshot['you']['bet'] =>
  snap && snap.you.bet && snap.you.bet.cash === null && snap.table.phase !== 'crashed' ? snap.you.bet : null

/** Called every frame: the parts that move with the clock. */
function renderLive(): void {
  const props = sceneProps()
  const { input, multiplier, serverNow: now } = sceneInputFor(props, 0)
  paint(drawScene(input, W, H))

  const mine = liveBet()
  if (!snap) {
    setText(el.big, '')
    setText(el.sub, '')
  } else if (props.phase === 'betting') {
    setText(el.big, `${seconds(props.bettingEndsAt - now)}s`)
    el.big.style.color = 'var(--amber)'
    setText(el.sub, 'BETS OPEN')
  } else if (props.phase === 'running') {
    setText(el.big, times(multiplier))
    el.big.style.color = multiplier >= 2 ? 'var(--green)' : '#fff'
    setText(el.sub, mine ? `your bet pays ${fmt(payoutFor(mine.amount, multiplier))}` : '')
  } else {
    setText(el.big, times(props.crashPoint ?? multiplier))
    el.big.style.color = 'var(--red)'
    setText(el.sub, 'CRASHED')
  }

  const canBet = isWorking && !!snap && snap.table.phase === 'betting' && !snap.you.bet && snap.table.bettingEndsAt - now > 150
  el.bet.disabled = !canBet
  el.cash.disabled = !(!!mine && props.phase === 'running') // an open bet can be cashed out after Claude has stopped too
  setText(el.cash.firstChild!, mine && props.phase === 'running' ? `Cash out ${fmt(payoutFor(mine.amount, multiplier))}` : 'Cash out')
}

/** Called when something changed: everything that is not tied to the clock. */
function renderStatic(): void {
  el.pill.textContent = !isOnline ? (hasCreds ? 'connecting…' : 'not linked') : isWorking ? '● Claude is working' : 'Claude is idle'
  el.pill.className = `pill ${isOnline && isWorking ? 'on' : 'warn'}`
  el.balance.textContent = isOnline ? fmt(balance) : '–'
  const delta = balanceAtStart === null ? 0 : balance - balanceAtStart
  el.delta.textContent = isOnline && (isWorking || snap) && balanceAtStart !== null ? `${sign(delta)} this turn` : ''
  el.delta.className = delta >= 0 ? 'up' : 'down'

  if (!hasCreds) {
    showLock('Not linked yet', 'Open this page from Claude Code: type /idlecrash in the chat.')
  } else if (!isOnline) {
    showLock('Connecting…', 'Trying to reach the server.')
  } else if (!isWorking && !snap) {
    showLock(summary ? 'Betting is locked' : 'Claude is idle', summary || 'Betting is open only while Claude works. Send it a task and come back.')
  } else {
    el.lock.hidden = true
  }
  // Claude has stopped but the round is still going: watch it out, no betting.
  el.watch.hidden = !(isOnline && !isWorking && snap)
  el.watch.textContent = (summary || 'Claude finished: betting is locked. Watching this round.') + (liveBet() ? ' Your bet is still in: cash out before the crash.' : '')

  const mine = snap?.you.bet ?? null
  el.bet.firstChild!.textContent = `Bet ${fmt(settings.stake)}`
  el.stakes.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.stake) === settings.stake))
  el.auto.firstChild!.textContent = `auto-out ${settings.auto ? times(settings.auto) : 'off'}`
  el.rebet.firstChild!.textContent = `rebet ${settings.rebet ? 'on' : 'off'}`
  el.rebet.classList.toggle('on', settings.rebet)
  el.auto.classList.toggle('on', settings.auto !== null)

  renderTable(mine)
}

function showLock(title: string, text: string): void {
  el.lock.hidden = false
  el.lock.replaceChildren()
  const b = document.createElement('b')
  b.textContent = title
  el.lock.append(b, document.createTextNode(text))
}

function renderTable(mine: Snapshot['you']['bet']): void {
  void mine
  el.players.replaceChildren()
  el.history.replaceChildren()
  if (!snap) {
    el.tableTitle.textContent = 'table'
    return
  }
  const phase = snap.table.phase
  el.tableTitle.textContent = `table ${snap.table.id} · ${snap.table.humans + snap.table.bots} seated${snap.table.bots ? ` (${snap.table.bots} bots)` : ''}`
  for (const p of snap.players) {
    const row = document.createElement('tr')
    if (p.you) row.className = 'me'
    const name = document.createElement('td')
    name.textContent = `${p.bot ? '⚙ ' : ''}${cleanName(p.name)}${p.you ? ' (you)' : ''}`
    const bet = document.createElement('td')
    bet.className = 'n'
    bet.textContent = p.bet > 0 ? fmt(p.bet) : '–'
    const result = document.createElement('td')
    if (p.bet > 0 && p.cash !== null) {
      result.className = 'won'
      result.textContent = `${times(p.cash)} → ${fmt(p.payout)}`
    } else if (p.bet > 0 && phase === 'crashed') {
      result.className = 'lost'
      result.textContent = 'lost'
    } else if (p.bet > 0) {
      result.className = 'dim'
      result.textContent = phase === 'betting' ? 'in' : '…'
    }
    row.append(name, bet, result)
    el.players.append(row)
  }
  for (const point of snap.history) {
    const chip = document.createElement('span')
    chip.textContent = point.toFixed(2)
    chip.className = point >= 2 ? 'won' : 'lost'
    el.history.append(chip)
  }
}

// ---- go ---------------------------------------------------------------------------------

let lastDraw = 0
function frame(time: number): void {
  requestAnimationFrame(frame)
  if (time - lastDraw < 33) return
  lastDraw = time
  renderLive()
}

fit()
renderStatic()
connect()
requestAnimationFrame(frame)
