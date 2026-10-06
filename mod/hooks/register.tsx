import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feed, Local, Snapshot, Status } from '../types'
import { AUTOS, STAKES, cleanName, fmt, pad, padStart, parseSnapshot, sign, times } from './shared/lib'
import type { SceneProps } from './shared/scene'
import { cleanBase } from './util'

const PANE = 'idlecrash'
const DEFAULT_BASE = 'http://localhost:8787'
const BEAT_MS = 2000
const AUTO_OPEN_EVERY_MS = 30 * 60_000

const feed = atom({ plugin: 'idlecrash', key: 'feed' } as const, { snap: null, offset: 0 } as Feed)
const local = atom({ plugin: 'idlecrash', key: 'local' } as const, { stake: 50, auto: 2, isRebet: false } as Local)
const status = atom(
  { plugin: 'idlecrash', key: 'status' } as const,
  { isWorking: false, isJoined: false, isWatching: false, error: null, note: null, balanceAtStart: null, summary: null } as Status,
)

const ERRORS: Record<string, string> = {
  closed: 'Bets are closed this round',
  'already-bet': 'You already have a bet',
  'no-bet': 'No open bet',
  'too-late': 'Too late, it crashed',
  'bad-amount': 'That stake is not allowed',
  'bad-auto': 'That auto cash-out is not allowed',
  poor: 'Not enough tokens',
  'not-seated': 'Not seated, rejoining',
  'rate-limited': 'Slow down, server is busy',
  locked: 'Claude is not working, betting is locked',
}

/** A refusal the player can read: the server's code is shown when we have no words for it. */
const refusal = (code: unknown, fallback: string): string => ERRORS[String(code)] ?? `${fallback} (${String(code)})`

/** `t0` and `t1` are our clock before and after the call, kept only where the offset is measured. */
type Reply = { status: number; json: any; t0?: number; t1?: number }

let base = DEFAULT_BASE
let isBaseValid = true
let nickOption = ''
let isAutoOpenOption = true
let browserMode: 'auto' | 'app' | 'system' = 'auto'
let timer: { cancel: () => void } | null = null
let creds: { id: string; secret: string } | null = null
let isBusy = false
let isMuted = false // the person closed the pane during this turn
let lastPoll = 0
let lastJoinTry = 0
let failures = 0
let toldNarrow = false
let notedKey = ''
let rebetRound = -1
let isActing = false // a bet or cash-out is in flight
let beatTimer: { cancel: () => void } | null = null // tells the server Claude is working
let sessionId = 'default'
let isWorking = false
let hasTerminal = true // the session draws on a terminal, so the game lives in the pane
let isPaneUnplaced = false // the pane is open but the window is too narrow to show it
let beatFailures = 0
let lastAutoOpen = -Infinity
let startBalance: number | null = null
let watchUntil = 0 // the pane stops watching a round that has not ended by then
let lastBalance: number | null = null
let lastSignature = ''
const samples: { rtt: number; offset: number }[] = []

/** The server's clock minus ours, from the call that came back fastest of the last few. */
function bestOffset(rtt: number, offset: number): number {
  samples.push({ rtt, offset })
  if (samples.length > 8) samples.shift()
  let best = samples[0]!
  for (const sample of samples) if (sample.rtt < best.rtt) best = sample
  return best.offset
}

/** What the player can see of a snapshot. Not the clock, so a quiet table makes no redraw. */
const signature = (snap: Snapshot): string =>
  JSON.stringify([snap.table, snap.players, snap.history, snap.you.name, snap.you.balance, snap.you.bet, snap.limits])

// ---- talking to the server ------------------------------------------------

async function api(
  $: EngineInterface,
  method: string,
  path: string,
  body?: unknown,
  isTimed = false,
): Promise<Reply> {
  if (!isBaseValid) throw new Error('invalid serverUrl')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (creds) headers.authorization = `Bearer ${creds.id}.${creds.secret}`
  // A press must reach the server first: no clock reads in front of the request.
  const t0 = isTimed ? await $.clock.now() : undefined
  const res = await $.http.fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t1 = isTimed ? await $.clock.now() : undefined
  let json: any = null
  try {
    json = JSON.parse(res.text)
  } catch {
    json = null
  }
  return { status: res.status, json, t0, t1 }
}

async function setNote($: EngineInterface, text: string): Promise<void> {
  await update($, status, s => ({ ...s, note: text }))
  $.clock.after(4000, () => {
    void update($, status, s => (s.note === text ? { ...s, note: null } : s))
  })
}

/** Stores the server's view, tells the player what just happened, and rebets if asked. */
async function apply($: EngineInterface, reply: Reply): Promise<Snapshot | null> {
  const snap = parseSnapshot(reply.json?.snapshot)
  if (!snap) return null
  const prev = await read($, feed)
  let offset = prev.offset
  if (reply.t0 !== undefined && reply.t1 !== undefined) {
    offset = bestOffset(reply.t1 - reply.t0, snap.now - (reply.t0 + reply.t1) / 2)
  }
  // Write only what changed: every write redraws the pane, and a redraw can eat a click.
  const sig = signature(snap)
  if (sig !== lastSignature || Math.abs(offset - prev.offset) > 150) {
    lastSignature = sig
    await update($, feed, () => ({ snap, offset }))
  }
  const before = await read($, status)
  if (before.balanceAtStart === null || before.error !== null) {
    await update($, status, s => ({ ...s, balanceAtStart: s.balanceAtStart ?? snap.you.balance, error: null }))
  }

  const mine = snap.you.bet
  const round = snap.table.round
  if (mine && mine.cash !== null && notedKey !== `${round}:won`) {
    notedKey = `${round}:won`
    await setNote($, `Won ${fmt(mine.payout)} at ${times(mine.cash)} (profit ${sign(mine.payout - mine.amount)})`)
  } else if (mine && mine.cash === null && snap.table.phase === 'crashed' && notedKey !== `${round}:lost`) {
    notedKey = `${round}:lost`
    await setNote($, `Crashed at ${times(snap.table.crashPoint ?? 1)}. Lost ${fmt(mine.amount)}`)
  }

  const wish = await read($, local)
  const st = await read($, status)
  const left = snap.table.bettingEndsAt - ((await $.clock.now()) + offset)
  if (
    wish.isRebet &&
    st.isWorking &&
    snap.table.phase === 'betting' &&
    !mine &&
    left > 700 &&
    rebetRound !== round &&
    prev.snap !== null
  ) {
    rebetRound = round
    await placeBet($)
  }
  return snap
}

async function join($: EngineInterface): Promise<void> {
  lastJoinTry = await $.clock.now()
  if (!creds) {
    const saved = (await $.store.get('creds')) as { id?: string; secret?: string } | undefined
    if (saved?.id && saved?.secret) creds = { id: saved.id, secret: saved.secret }
  }
  const nick = cleanName((await $.store.get('nickname')) ?? nickOption)
  try {
    const reply = await api(
      $,
      'POST',
      '/join',
      { id: creds?.id, secret: creds?.secret, name: nick || undefined },
      true,
    )
    if (!reply.json?.ok) throw new Error('refused')
    if (reply.json.creds?.id && reply.json.creds?.secret) {
      creds = { id: String(reply.json.creds.id), secret: String(reply.json.creds.secret) }
      await $.store.set('creds', creds)
    }
    await apply($, reply)
    failures = 0
    await update($, status, s => ({ ...s, isJoined: true, error: null }))
  } catch {
    await update($, status, s => ({ ...s, isJoined: false, error: `Cannot reach ${base}` }))
  }
}

async function leave($: EngineInterface): Promise<{ balance: number; refunded: number; cashed: number } | null> {
  if (!creds) return null
  try {
    const reply = await api($, 'POST', '/leave')
    await update($, status, s => ({ ...s, isJoined: false }))
    if (!reply.json?.ok) return null
    return {
      balance: Number(reply.json.balance) || 0,
      refunded: Number(reply.json.refunded) || 0,
      cashed: Number(reply.json.cashed) || 0,
    }
  } catch {
    await update($, status, s => ({ ...s, isJoined: false }))
    return null
  }
}

// ---- what the buttons do --------------------------------------------------

async function placeBet($: EngineInterface): Promise<void> {
  if (isActing) return
  isActing = true
  try {
    const wish = await read($, local)
    const reply = await api($, 'POST', '/bet', { amount: wish.stake, auto: wish.auto })
    if (reply.json?.ok) await apply($, reply)
    else await setNote($, refusal(reply.json?.error, 'Bet refused'))
  } catch {
    await setNote($, 'Server did not answer')
  } finally {
    isActing = false
  }
}

async function cashOut($: EngineInterface): Promise<void> {
  if (isActing) return
  isActing = true
  try {
    // The request goes first. The note only says it is on its way.
    const pending = api($, 'POST', '/cashout')
    const hint = setNote($, 'Cashing out…')
    const reply = await pending
    await hint
    if (reply.json?.ok) await apply($, reply)
    else await setNote($, refusal(reply.json?.error, 'Cash out refused'))
  } catch {
    await setNote($, 'Server did not answer')
  } finally {
    isActing = false
  }
}

// ---- the turn ------------------------------------------------------------

/** The pane stops watching: back to the summary. */
async function endWatching($: EngineInterface): Promise<void> {
  timer?.cancel()
  timer = null
  await update($, status, s => ({ ...s, isWatching: false, isJoined: false }))
}

async function tick($: EngineInterface): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const st = await read($, status)
    if (!st.isWorking && !st.isWatching) return
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    isPaneUnplaced = !!pane && !pane.isPlaced
    if (!pane || !pane.isPlaced) {
      if (st.isWatching) await endWatching($)
      else if (st.isJoined) await leave($)
      return
    }
    const now = await $.clock.now()
    if (st.isWatching && (now > watchUntil || !st.isJoined)) return void (await endWatching($))
    if (!st.isJoined) {
      if (now - lastJoinTry > 3000) await join($)
      return
    }
    const phase = (await read($, feed)).snap?.table.phase
    if (now - lastPoll < (phase === 'running' ? 380 : 1100)) return
    lastPoll = now
    try {
      const reply = await api($, 'GET', '/state', undefined, true)
      if (reply.status === 409 || reply.status === 401) {
        if (reply.status === 401) creds = null
        // A watcher's round is over: the server took the seat away.
        if (st.isWatching) await endWatching($)
        else await update($, status, s => ({ ...s, isJoined: false }))
        return
      }
      if (!(await apply($, reply))) throw new Error('bad reply')
      failures = 0
    } catch {
      failures += 1
      if (failures >= 3) await update($, status, s => ({ ...s, error: `Cannot reach ${base}` }))
    }
  } finally {
    isBusy = false
  }
}

// ---- the account, the browser, and "Claude is working" -----------------------------

/** Finds the player's account, or makes one the first time. The secret stays in this plugin's store. */
async function ensureAccount($: EngineInterface): Promise<boolean> {
  if (!creds) {
    const saved = (await $.store.get('creds')) as { id?: string; secret?: string } | undefined
    if (saved?.id && saved?.secret) creds = { id: saved.id, secret: saved.secret }
  }
  const nick = cleanName((await $.store.get('nickname')) ?? nickOption)
  const reply = await api($, 'POST', '/account', { id: creds?.id, secret: creds?.secret, name: nick || undefined })
  if (!reply.json?.ok) return false
  if (reply.json.creds?.id && reply.json.creds?.secret) {
    creds = { id: String(reply.json.creds.id), secret: String(reply.json.creds.secret) }
    await $.store.set('creds', creds)
  }
  return true
}

/** Opens the address in the app's own browser panel. Null when it opened; else why it did not. */
async function openInApp($: EngineInterface, url: string): Promise<string | null> {
  try {
    const tool = (await $.tool.list()).find(t => t.mcp && /Claude_Browser__preview_start$/.test(t.name))
    if (!tool) return 'this session has no browser-panel tool'
    // The same call the model would make, so the usual permission check applies.
    const res = (await $.tool.call({ tool: tool.name, url } as never)) as { deny?: string; isError?: boolean }
    if (res.deny !== undefined) return `the call was refused (${String(res.deny).slice(0, 80)})`
    return res.isError === true ? 'the panel reported an error' : null
  } catch (err) {
    return `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`
  }
}

/**
 * Opens the game page with a one-time code in the address, so the browser gets a key of
 * its own and never sees this plugin's secret. It goes to the app's browser panel when
 * there is one, else to the default browser. Returns the address, whether something
 * opened it, and where.
 */
async function openPage(
  $: EngineInterface,
): Promise<{ url: string; isOpened: boolean; via: 'app' | 'system' | null; appWhy: string | null } | null> {
  const link = await api($, 'POST', '/link', {})
  const code = link.json?.code
  if (!link.json?.ok || typeof code !== 'string' || !/^[\w-]{6,40}$/.test(code)) return null
  const url = `${base}/?c=${code}`
  let appWhy: string | null = null
  if (browserMode !== 'system') {
    appWhy = await openInApp($, url)
    if (appWhy === null) return { url, isOpened: true, via: 'app', appWhy }
  }
  if (browserMode === 'app') return { url, isOpened: false, via: null, appWhy }
  for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    try {
      const run = await $.process.run(argv, { timeoutMs: 8000 })
      if (run.exitCode === 0) return { url, isOpened: true, via: 'system', appWhy }
    } catch {
      // That program is not here; try the next one.
    }
  }
  return { url, isOpened: false, via: null, appWhy }
}

async function openInBrowser($: EngineInterface): Promise<string> {
  try {
    if (!(await ensureAccount($))) return `IdleCrash: the server at ${base} did not accept the account.`
    const page = await openPage($)
    if (!page) return 'IdleCrash: the server gave no link.'
    // Say why the panel was skipped, or a fallback to another browser looks like a bug.
    const skipped = page.appWhy ? ` (The app's browser panel was not used: ${page.appWhy}.)` : ''
    if (!page.isOpened) return `IdleCrash: could not open a browser${skipped} Open ${page.url}`
    return `IdleCrash opened in ${page.via === 'app' ? "the app's browser panel" : 'your browser'}. Betting is open while Claude works.${skipped}`
  } catch {
    return `IdleCrash: cannot reach ${base}. Is the server running?`
  }
}

async function openFromPane($: EngineInterface): Promise<void> {
  $.ui.toast(await openInBrowser($), { timeoutMs: 8000 })
}

async function maybeAutoOpen($: EngineInterface): Promise<void> {
  const wants = ((await $.store.get('autoOpen')) ?? isAutoOpenOption) !== false
  const now = await $.clock.now()
  if (!wants || now - lastAutoOpen < AUTO_OPEN_EVERY_MS) return
  lastAutoOpen = now
  const page = await openPage($)
  if (page && !page.isOpened) $.ui.toast(`IdleCrash: open ${page.url}`, { timeoutMs: 15_000 })
}

/** Every 2 seconds while a turn runs. The server opens betting on this and locks it when it stops. */
async function beat($: EngineInterface): Promise<void> {
  if (!isWorking) return
  try {
    if (!creds && !(await ensureAccount($))) throw new Error('no account')
    const reply = await api($, 'POST', '/presence', { working: true, session: sessionId })
    if (reply.status === 401) {
      creds = null // the server does not know us any more: make a new account on the next beat
      await $.store.delete('creds')
      throw new Error('unauthorized')
    }
    if (!reply.json?.ok) throw new Error('refused')
    beatFailures = 0
    const balance = Number(reply.json.balance) || 0
    startBalance ??= balance
    lastBalance = balance
    const isPageOpen = reply.json.pageOpen === true
    // The terminal plays in its pane. Everywhere else, and when the pane has no room, in the browser.
    if (!isPageOpen && (!hasTerminal || isPaneUnplaced)) await maybeAutoOpen($)
    if (!hasTerminal) {
      $.ui.status(
        `IdleCrash: ${isPageOpen ? 'playing in your browser' : 'page closed, /idlecrash opens it'} · balance ${fmt(balance)} (${sign(balance - startBalance)})`,
      )
    }
  } catch {
    beatFailures += 1
    if (beatFailures === 2 && !hasTerminal) $.ui.status(`IdleCrash: cannot reach ${base}`)
  }
}

// ---- the turn ------------------------------------------------------------------------

async function begin($: EngineInterface): Promise<void> {
  isMuted = false
  toldNarrow = false
  failures = 0
  beatFailures = 0
  notedKey = ''
  rebetRound = -1
  lastSignature = ''
  samples.length = 0
  startBalance = null
  isWorking = true
  isPaneUnplaced = false
  sessionId = await $.session.id()
  hasTerminal = (await $.session.surfaces()).includes('terminal')
  await update($, status, () => ({
    isWorking: true,
    isJoined: false,
    isWatching: false,
    error: null,
    note: null,
    balanceAtStart: null,
    summary: null,
  }))
  if (base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
    $.ui.log('idlecrash: the server URL is plain http, so your play-account secret is not encrypted', { to: 'debug' })
  }
  beatTimer?.cancel()
  beatTimer = $.clock.every(BEAT_MS, () => {
    void beat($)
  })
  await beat($)
  if (!hasTerminal) {
    $.ui.status('IdleCrash: connecting…')
    return
  }
  const wantsOpen = ((await $.store.get('autoOpen')) ?? isAutoOpenOption) !== false
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (wantsOpen || isOpen) {
    const opened = await $.ui.open({ id: PANE, title: 'IdleCrash' })
    if (!opened.isPlaced) {
      isPaneUnplaced = true
      if (!toldNarrow) {
        toldNarrow = true
        $.ui.toast('IdleCrash: the window is narrower than 144 columns, so the game opens in your browser')
      }
    }
  }
  timer?.cancel()
  timer = $.clock.every(200, () => {
    void tick($)
  })
}

async function finish($: EngineInterface): Promise<void> {
  beatTimer?.cancel()
  beatTimer = null
  if (!isWorking) {
    timer?.cancel()
    timer = null
    return
  }
  isWorking = false
  // Stopping the heartbeat settles an open bet on the server: cashed out, or refunded.
  let text = 'Claude finished, betting is locked.'
  try {
    const reply = await api($, 'POST', '/presence', { working: false, session: sessionId })
    if (reply.json?.ok) {
      const balance = Number(reply.json.balance) || lastBalance || 0
      text += ` Balance ${fmt(balance)}`
      if (startBalance !== null) text += ` (${sign(balance - startBalance)} this turn)`
      text += '.'
      const cashed = Number(reply.json.locked?.cashed) || 0
      const refunded = Number(reply.json.locked?.refunded) || 0
      if (cashed > 0) text += ` Your open bet was cashed out for you (+${fmt(cashed)}).`
      if (refunded > 0) text += ` Your open bet was refunded (${fmt(refunded)}).`
    }
  } catch {
    // The server did not answer: it locks by itself when the beats stop.
  }
  // On a terminal the pane stays and keeps showing this round to its end; the server holds the seat for it.
  const wasSeated = (await read($, status)).isJoined
  const isWatching = hasTerminal && wasSeated
  if (isWatching) watchUntil = (await $.clock.now()) + 120_000
  else {
    timer?.cancel()
    timer = null
  }
  await update($, status, s => ({ ...s, isWorking: false, isWatching, isJoined: isWatching, summary: text, note: null }))
  $.ui.toast(text, { timeoutMs: 6000 })
  if (!hasTerminal) {
    $.ui.status(`IdleCrash: ${text}`)
    $.clock.after(20_000, () => {
      if (!isWorking) $.ui.status(undefined)
    })
  }
}

export const register: Register = (on, options) => {
  const clean = cleanBase(options.serverUrl || DEFAULT_BASE)
  isBaseValid = clean !== null
  base = clean ?? DEFAULT_BASE
  nickOption = String(options.nickname ?? '')
  isAutoOpenOption = options.autoOpen !== false
  browserMode = options.browser === 'app' || options.browser === 'system' ? options.browser : 'auto'

  // ---- hooks ----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'idlecrash',
      description: 'IdleCrash: bet fake tokens while Claude works',
      argumentHint: '[web|link|on|off|name <nick>|top]',
      immediate: true,
    })
    await update($, status, () => ({
      isWorking: false,
      isJoined: false,
      isWatching: false,
      error: null,
      note: null,
      balanceAtStart: null,
      summary: null,
    }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(1, () => {
      void begin($)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      $.clock.after(1, () => {
        void finish($)
      })
    }
    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      isMuted = true
      $.clock.after(1, () => {
        void leave($)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'idlecrash' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    if (!isBaseValid) return { text: 'IdleCrash: serverUrl must look like https://host or http://host:port. Fix it in /config.' }
    switch (sub.toLowerCase()) {
      case 'off':
        await $.store.set('autoOpen', false)
        return { text: 'IdleCrash will not open by itself. Type /idlecrash to open it.' }
      case 'on':
        await $.store.set('autoOpen', true)
        return { text: 'IdleCrash will open by itself when Claude starts working.' }
      case 'name': {
        const nick = cleanName(rest.join(' '))
        if (nick.length < 2) return { text: 'Usage: /idlecrash name <nickname> (2-16 letters or digits)' }
        await $.store.set('nickname', nick)
        try {
          await ensureAccount($)
        } catch {
          return { text: `Nickname saved as ${nick}; the server is not reachable now, so it will apply later.` }
        }
        return { text: `Nickname set to ${nick}.` }
      }
      case 'top': {
        try {
          const res = await $.http.fetch(`${base}/top`)
          const parsed = JSON.parse(res.text)
          const top: { name: string; balance: number }[] = Array.isArray(parsed?.top) ? parsed.top : []
          if (top.length === 0) return { text: 'Nobody on the board yet.' }
          const lines = top.slice(0, 10).map((p, i) => `${i + 1}. ${cleanName(p.name)}  ${fmt(Number(p.balance) || 0)}`)
          return { text: ['IdleCrash top:', ...lines].join('\n') }
        } catch {
          return { text: `Cannot reach ${base}` }
        }
      }
      case 'help':
        return {
          text: [
            'IdleCrash: bet fake tokens while Claude works.',
            '/idlecrash          open the game (in the pane on a terminal, in the browser elsewhere)',
            '/idlecrash web      open it in a browser (the app\'s panel when there is one)',
            '/idlecrash link     print the browser address instead',
            '/idlecrash on|off  open it by itself when Claude starts working, or not',
            '/idlecrash name <nick>   /idlecrash top',
            'Keys in the pane (click it or ctrl+x tab first): b bet, c cash out, 1-4 stake, x auto cash-out, r rebet.',
          ].join('\n'),
        }
      case 'link': {
        try {
          if (!(await ensureAccount($))) return { text: `IdleCrash: the server at ${base} did not accept the account.` }
          const link = await api($, 'POST', '/link', {})
          return { text: link.json?.code ? `${base}/?c=${link.json.code}  (works once, for 2 minutes)` : 'IdleCrash: no link.' }
        } catch {
          return { text: `IdleCrash: cannot reach ${base}. Is the server running?` }
        }
      }
      case 'web':
        return { text: await openInBrowser($) }
      default: {
        if (!(await $.session.surfaces()).includes('terminal')) return { text: await openInBrowser($) }
        isMuted = false
        const opened = await $.ui.open({ id: PANE, title: 'IdleCrash', focus: true })
        const st = await read($, status)
        if (!opened.isPlaced) return { text: `IdleCrash: the window is too narrow for the pane. ${await openInBrowser($)}` }
        return {
          text: st.isWorking
            ? 'IdleCrash is open. b bet, c cash out, 1-4 stake, x auto, r rebet.'
            : 'IdleCrash is open. You can play while Claude is working.',
        }
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, feed)
    const wish = await read($, local)
    const st = await read($, status)
    const width = Math.max(30, (e.props.bodyColumns ?? 40) - 1)
    const snap = f.snap

    const title = (
      <Box>
        <Text bold>IDLECRASH</Text>
        <Text dimColor>  fake tokens only</Text>
      </Box>
    )

    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {title}
          <Text>The game opens in your browser.</Text>
          <Text dimColor>{st.isWorking ? 'Claude is working: bets are open.' : 'Bets open when Claude starts working.'}</Text>
          <Button key="web" label="o · Open the game" hotkey="o" variant="primary" onPress={() => openFromPane($)} />
        </Box>
      )
    }

    if (!st.isWorking && !st.isWatching && st.summary) {
      return (
        <Box flexDirection="column">
          {title}
          <Text color="warning">{st.summary}</Text>
          <Text dimColor>Betting opens again when Claude starts the next turn.</Text>
          <Text dimColor>{snap && snap.history.length > 0 ? `last crashes: ${snap.history.slice(0, 8).map(point => point.toFixed(2)).join(' ')}` : ' '}</Text>
        </Box>
      )
    }
    if (!st.isWorking && !st.isWatching) {
      return (
        <Box flexDirection="column">
          {title}
          <Text>Waiting for Claude to start working.</Text>
          <Text dimColor>You can only play while Claude is busy.</Text>
          <Text dimColor>/idlecrash off  stops it opening by itself</Text>
        </Box>
      )
    }
    if (!snap || !st.isJoined) {
      return (
        <Box flexDirection="column">
          {title}
          {st.error ? <Text color="error">{st.error}</Text> : <Text dimColor>Taking a seat…</Text>}
        </Box>
      )
    }

    // Nothing below changes between two redraws unless the table changed: the moving parts
    // (plane, multiplier, countdown) live in the picture, which animates on its own.
    const phase = snap.table.phase
    const mine = snap.you.bet
    const isLive = !!mine && mine.cash === null && phase !== 'crashed'
    const delta = st.balanceAtStart === null ? 0 : snap.you.balance - st.balanceAtStart
    const seated = snap.table.humans + snap.table.bots
    const columns = Math.min(56, Math.max(28, width))
    const rowsOfPicture = 14
    const sceneProps: SceneProps = {
      phase,
      round: snap.table.round,
      columns,
      rows: rowsOfPicture,
      growth: snap.growth,
      runStartedAt: snap.table.runStartedAt,
      crashedAt: snap.table.crashedAt,
      crashPoint: snap.table.crashPoint,
      bettingEndsAt: snap.table.bettingEndsAt,
      serverNow: (await $.clock.now()) + f.offset,
      stake: isLive && phase === 'running' ? mine!.amount : 0,
    }

    const { Client } = $.ui.resolve(e)
    const picture = (
      <Client key="scene" module="./scene-client.tsx" props={sceneProps} width={columns} height={rowsOfPicture + 1} />
    )

    const rows = snap.players.map(p => {
      const name = pad(`${p.you ? '›' : ' '}${p.bot ? '⚙' : ' '}${p.name}`, 12)
      let result = ''
      let color: string | undefined
      if (p.bet > 0) {
        if (p.cash !== null) {
          result = `${times(p.cash)} → ${fmt(p.payout)}`
          color = 'success'
        } else if (phase === 'crashed') {
          result = 'lost'
          color = 'error'
        } else {
          result = phase === 'betting' ? 'in' : '…'
        }
      }
      return (
        <Box>
          <Text bold={p.you}>{name} {padStart(p.bet > 0 ? fmt(p.bet) : '-', 5)}  </Text>
          <Text color={color} dimColor={!color}>{result}</Text>
        </Box>
      )
    })

    const room = Math.max(3, Math.floor((width - 6) / 6))

    let action
    if (!st.isWorking) {
      action = <Text color="warning">Claude finished: betting is locked. Watching this round.</Text>
    } else if (phase === 'betting' && !mine) {
      action = <Button key="bet" label={`b · Bet ${fmt(wish.stake)}`} hotkey="b" variant="primary" onPress={() => placeBet($)} />
    } else if (isLive && phase === 'running') {
      action = <Button key="cash" label="c · CASH OUT" hotkey="c" variant="primary" onPress={() => cashOut($)} />
    } else if (mine && phase === 'betting') {
      action = <Text color="warning">bet placed: {fmt(mine.amount)}{mine.auto ? ` · auto ${times(mine.auto)}` : ''}</Text>
    } else if (mine && mine.cash !== null) {
      action = <Text color="success">cashed out {times(mine.cash)}: paid {fmt(mine.payout)}</Text>
    } else {
      action = <Text dimColor>next round soon</Text>
    }

    return (
      <Box flexDirection="column">
        {title}
        {picture}
        <Text dimColor>table {snap.table.id} · {seated} seated{snap.table.bots > 0 ? ` (${snap.table.bots} bots ⚙)` : ''}</Text>
        <Box>
          <Text>balance <Text bold>{fmt(snap.you.balance)}</Text></Text>
          <Text color={delta >= 0 ? 'success' : 'error'}>  {sign(delta)} this turn</Text>
        </Box>
        <Box flexDirection="column">{rows}</Box>
        <Box>
          <Text dimColor>last </Text>
          {snap.history.slice(0, room).map(point => (
            <Text color={point >= 2 ? 'success' : 'error'}>{point.toFixed(2)} </Text>
          ))}
        </Box>
        <Box>{action}</Box>
        <Box>
          <Text dimColor>{st.isWorking ? 'stake ' : ' '}</Text>
          {(st.isWorking ? STAKES : []).map((s, i) => (
            <Button
              key={`stake${i + 1}`}
              plain
              hotkey={String(i + 1)}
              label={fmt(s)}
              dimColor={wish.stake !== s}
              onPress={() => update($, local, w => ({ ...w, stake: s }))}
            />
          ))}
        </Box>
        <Box>
          {st.isWorking && (<Button
            key="auto"
            plain
            hotkey="x"
            label={`auto-out ${wish.auto ? times(wish.auto) : 'off'}`}
            onPress={() =>
              update($, local, w => ({ ...w, auto: AUTOS[(AUTOS.indexOf(w.auto) + 1) % AUTOS.length] ?? null }))
            }
          />)}
          <Text>{st.isWorking ? '  ' : ' '}</Text>
          {st.isWorking && (<Button
            key="rebet"
            plain
            hotkey="r"
            label={`rebet ${wish.isRebet ? 'on' : 'off'}`}
            onPress={() => update($, local, w => ({ ...w, isRebet: !w.isRebet }))}
          />)}
        </Box>
        <Text color={st.error ? 'error' : 'warning'}>{st.error ?? st.note ?? (st.isWorking ? ' ' : (st.summary ?? ' '))}</Text>
        <Text dimColor>{st.isWorking ? 'Claude is working. Bets lock when it finishes.' : ' '}</Text>
      </Box>
    )
  })
}
