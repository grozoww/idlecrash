// GENERATED from /shared by tools/sync-shared.ts. Edit the original, not this copy.
import type { Phase, Row, Snapshot } from './types'

export const STAKES = [10, 50, 100, 500]
export const AUTOS: (number | null)[] = [null, 1.5, 2, 3, 5, 10]

export const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const times = (m: number): string => `${m.toFixed(2)}x`
export const sign = (n: number): string => (n >= 0 ? `+${fmt(n)}` : `-${fmt(-n)}`)

/** What a stake pays at a multiplier: whole tokens, rounded down, as the server does. */
export const payoutFor = (amount: number, multiplier: number): number =>
  Math.floor((amount * Math.round(multiplier * 100)) / 100)

export const seconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000))

/** The multiplier the server's clock reads `elapsedMs` after the flight began. */
export const multiplierAt = (elapsedMs: number, growth: number): number =>
  Math.floor(100 * Math.exp((growth * Math.max(0, elapsedMs)) / 1000) + 1e-9) / 100

/** Everything from the network is drawn in a terminal: keep letters, digits and a few marks. */
export function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return text
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16)
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const nul = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const PHASES: Phase[] = ['betting', 'running', 'crashed']

/** Reads a server reply as data. Anything off-shape is dropped, never trusted. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  const s = raw as Record<string, any> | null
  if (!s || typeof s !== 'object' || !s.table || !s.you) return null
  const phase: Phase = PHASES.includes(s.table.phase) ? s.table.phase : 'betting'
  const players: Row[] = (Array.isArray(s.players) ? s.players : []).slice(0, 12).map((p: any) => ({
    name: cleanName(p?.name) || '?',
    bot: p?.bot === true,
    you: p?.you === true,
    bet: num(p?.bet),
    cash: nul(p?.cash),
    payout: num(p?.payout),
  }))
  const bet = s.you.bet
  return {
    now: num(s.now),
    growth: num(s.growth, 0.12),
    table: {
      id: String(s.table.id ?? '').replace(/[^\w-]/g, '').slice(0, 8),
      round: num(s.table.round),
      phase,
      phaseStartedAt: num(s.table.phaseStartedAt),
      bettingEndsAt: num(s.table.bettingEndsAt),
      runStartedAt: nul(s.table.runStartedAt),
      crashedAt: nul(s.table.crashedAt),
      crashPoint: nul(s.table.crashPoint),
      humans: num(s.table.humans),
      bots: num(s.table.bots),
    },
    players,
    history: (Array.isArray(s.history) ? s.history : []).slice(0, 12).map((h: unknown) => num(h, 1)),
    you: {
      name: cleanName(s.you.name) || 'you',
      balance: num(s.you.balance),
      bet: bet && typeof bet === 'object'
        ? { amount: num(bet.amount), auto: nul(bet.auto), cash: nul(bet.cash), payout: num(bet.payout) }
        : null,
      refillAt: nul(s.you.refillAt),
    },
    limits: { minBet: num(s.limits?.minBet, 10), maxBet: num(s.limits?.maxBet, 1000) },
  }
}

/** What the player sees right now, from the last snapshot and the clock. */
export function liveMultiplier(snap: Snapshot, serverNow: number): number | null {
  if (snap.table.phase === 'crashed') return snap.table.crashPoint
  if (snap.table.phase !== 'running' || snap.table.runStartedAt === null) return null
  return multiplierAt(serverNow - snap.table.runStartedAt, snap.growth)
}

export const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
export const padStart = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
