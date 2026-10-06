// A pretend game server and a pretend Claude Code, shared by the mod's tests.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The address the mod ships with. If the default changes, the tests say so. */
export const BASE = 'https://178-105-28-170.sslip.io'

export type Opts = {
  down?: boolean
  surfaces?: string[]
  isPlaced?: boolean
}

export type Call = { method: string; path: string; body: any; auth: string | null }

type Bet = { amount: number; auto: number | null; cash: number | null; payout: number } | null

export function world(on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)

  const calls: Call[] = []
  const state = {
    down: opts.down ?? false,
    accounts: 0,
    refuse: null as string | null, // make /bet and /cashout answer with this error code
    seatKept: false, // after "Claude finished" the server keeps the seat until the round is over
    roundOver: false,
    round: 1,
    phase: 'betting' as 'betting' | 'running' | 'crashed',
    phaseStart: clock.now(),
    crash: 3.2,
    balance: 1000,
    bet: null as Bet,
    playerName: 'me',
  }

  const snapshot = () => ({
    now: clock.now(),
    growth: 0.12,
    table: {
      id: 't1',
      round: state.round,
      phase: state.phase,
      phaseStartedAt: state.phaseStart,
      bettingEndsAt: state.phaseStart + 8000,
      runStartedAt: state.phase === 'betting' ? null : state.phaseStart + 8000,
      crashedAt: state.phase === 'crashed' ? state.phaseStart + 12000 : null,
      crashPoint: state.phase === 'crashed' ? state.crash : null,
      humans: 4,
      bots: 1,
    },
    players: [
      { name: state.playerName, bot: false, you: true, bet: state.bet?.amount ?? 0, cash: state.bet?.cash ?? null, payout: state.bet?.payout ?? 0 },
      { name: 'Nova', bot: true, you: false, bet: 50, cash: null, payout: 0 },
    ],
    history: [2.1, 1.0, 5.5],
    you: { name: state.playerName, balance: state.balance, bet: state.bet, refillAt: null },
    limits: { minBet: 10, maxBet: 1000 },
  })

  const answer = (body: unknown, status = 200) => ({
    value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
  })

  const handle = (_$: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    if (state.down) throw new Error('connection refused')
    const path = new URL(e.url).pathname
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : {}
    calls.push({ method, path, body, auth: e.init?.headers?.authorization ?? null })
    const key = `${method} ${path}`
    switch (key) {
      case 'POST /account':
        state.accounts += 1
        return answer({ ok: true, creds: { id: 'acct1', secret: 'secret1' }, name: 'Guest1234', balance: state.balance })
      case 'POST /presence': {
        if (body.working === false) state.seatKept = true
        return answer({ ok: true, name: 'Guest1234', balance: state.balance })
      }
      case 'GET /top':
        return answer({ ok: true, top: [{ name: '\u001b[31mEve', balance: 5000 }, { name: 'Bob', balance: 1200 }] })
      case 'POST /join':
        return answer({ ok: true, creds: { id: 'acct1', secret: 'secret1' }, snapshot: snapshot() })
      case 'GET /state':
        if (state.seatKept && state.roundOver) return answer({ ok: false, error: 'not-seated' }, 409)
        return answer({ ok: true, snapshot: snapshot() })
      case 'POST /bet': {
        if (state.refuse) return answer({ ok: false, error: state.refuse }, 409)
        state.balance -= body.amount
        state.bet = { amount: body.amount, auto: body.auto, cash: null, payout: 0 }
        return answer({ ok: true, snapshot: snapshot() })
      }
      case 'POST /cashout': {
        if (state.refuse) return answer({ ok: false, error: state.refuse }, 409)
        state.bet = { ...state.bet!, cash: 2, payout: state.bet!.amount * 2 }
        state.balance += state.bet.payout
        return answer({ ok: true, snapshot: snapshot() })
      }
      case 'POST /leave': {
        const refunded = state.phase === 'betting' && state.bet ? state.bet.amount : 0
        state.balance += refunded
        return answer({ ok: true, refunded, cashed: 0, balance: state.balance })
      }
      default:
        return answer({ ok: false, error: 'not-found' }, 404)
    }
  }

  const toasts: string[] = []
  const paneOpens: unknown[] = []
  const invalidates: unknown[] = [] // redraws the plugin asked for
  on('http.fetch', handle as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: { command: 'idlecrash' } }))
  on('session.id', () => ({ value: 'session-A' }))
  // A terminal by default. The desktop app has a pane of ours too; an editor or a phone has none.
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }) as never)
  // The pane is listed once the mod has opened it.
  on('ui.panes', () => ({
    value: paneOpens.length > 0 ? [{ id: 'idlecrash', title: 'IdleCrash', isShown: true, isFocused: false, isPlaced: opts.isPlaced ?? true }] : [],
  }))
  on('ui.open', (_$, e) => {
    paneOpens.push(e)
    return { value: { isPlaced: opts.isPlaced ?? true } } as never
  })
  on('ui.invalidate', (_$, e) => {
    invalidates.push(e)
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })

  return { clock, calls, state, toasts, paneOpens, invalidates }
}

export const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
export const DONE = { answer: '', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as const
export const PANE_PROPS = {
  title: 'IdleCrash',
  isFocused: false,
  bodyColumns: 44,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as never

export const paths = (calls: Call[]): string[] => calls.map(c => `${c.method} ${c.path}`)
export const run = ($: any, args = '') => $.command.run({ command: 'idlecrash', args })
