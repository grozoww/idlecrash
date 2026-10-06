export type Phase = 'betting' | 'running' | 'crashed'

export type Row = {
  name: string
  bot: boolean
  you: boolean
  bet: number
  cash: number | null
  payout: number
}

export type Snapshot = {
  now: number
  growth: number
  table: {
    id: string
    round: number
    phase: Phase
    phaseStartedAt: number
    bettingEndsAt: number
    runStartedAt: number | null
    crashedAt: number | null
    crashPoint: number | null
    humans: number
    bots: number
  }
  players: Row[]
  history: number[]
  you: {
    name: string
    balance: number
    bet: { amount: number; auto: number | null; cash: number | null; payout: number } | null
    refillAt: number | null
  }
  limits: { minBet: number; maxBet: number }
}

/** The last server view, and how far the server's clock is ahead of ours. */
export type Feed = { snap: Snapshot | null; offset: number }

/** What the player picked: stake, auto cash-out target, rebet each round. */
export type Local = { stake: number; auto: number | null; isRebet: boolean }

export type Status = {
  /** A turn is running: the only time anyone may play. */
  isWorking: boolean
  /** Seated at a table on the server. */
  isJoined: boolean
  /** Claude stopped, but the round is still on: the pane keeps showing it, without betting. */
  isWatching: boolean
  error: string | null
  note: string | null
  /** The balance when this turn's play began, to show what the wait was worth. */
  balanceAtStart: number | null
  /** Set when the turn ended while playing: betting is locked until the next turn. */
  summary: string | null
}

declare module 'claude-code' {
  interface PluginState {
    idlecrash: { feed: Feed; local: Local; status: Status }
  }
}
