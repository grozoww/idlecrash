// GENERATED from /shared by tools/sync-shared.ts. Edit the original, not this copy.
export type Phase = 'betting' | 'running' | 'crashed'

export type Row = {
  name: string
  bot: boolean
  you: boolean
  bet: number
  cash: number | null
  payout: number
}

/** What the server sends about a table. The page reads it as data, never as code. */
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
