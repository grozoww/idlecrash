// IdleCrash game engine: pure logic, no HTTP, no disk. Time and randomness are
// passed in so the tests can drive it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type Phase = 'betting' | 'running' | 'crashed'

export type Config = {
  seats: number // humans + bots per table
  botPct: number // bots may be at most this % of a table's seats
  bettingMs: number
  crashedMs: number
  growth: number // multiplier = e^(growth * seconds)
  minBet: number
  maxBet: number
  startBalance: number
  refillBelow: number
  refillTo: number
  refillEveryMs: number
  idleKickMs: number // no poll for this long = player left
  presenceMs: number // the mod's heartbeat: no beat for this long = Claude is not working
  linkMs: number // how long a link code to open the page stays valid
  emptyTableMs: number
  maxMultiplier: number
  maxAccounts: number // no new accounts beyond this many
  idleAccountMs: number // accounts unseen for this long are dropped
  edgePct: number
}

export const DEFAULTS: Config = {
  seats: 10,
  botPct: 30,
  bettingMs: 8000,
  crashedMs: 4000,
  growth: 0.12,
  minBet: 10,
  maxBet: 1000,
  startBalance: 1000,
  refillBelow: 10,
  refillTo: 200,
  refillEveryMs: 10 * 60_000,
  idleKickMs: 20_000,
  presenceMs: 8000,
  linkMs: 120_000,
  emptyTableMs: 30_000,
  maxMultiplier: 1000,
  maxAccounts: 100_000,
  idleAccountMs: 90 * 24 * 3600_000,
  edgePct: 1,
}

// ---- math -----------------------------------------------------------------

export const multiplierAt = (elapsedMs: number, growth: number): number =>
  Math.floor(100 * Math.exp((growth * Math.max(0, elapsedMs)) / 1000) + 1e-9) / 100

export const msToReach = (multiplier: number, growth: number): number =>
  (Math.log(multiplier) / growth) * 1000

// The flight ends when the raw curve reaches crashPoint + 0.01, so the last
// number a player sees is exactly the crash point. 1.00 crashes at once.
export const crashMsFor = (crashPoint: number, growth: number): number =>
  crashPoint <= 1 ? 0 : msToReach(crashPoint + 0.01, growth)

// P(crashPoint >= x) = (1 - edge) / x for x >= 1.
export function rollCrashPoint(rand: () => number, edgePct: number, max: number): number {
  const raw = (100 - edgePct) / 100 / (1 - rand())
  return Math.min(max, Math.max(1, Math.floor(raw * 100) / 100))
}

export function secureRandom(): number {
  const b = new Uint32Array(2)
  crypto.getRandomValues(b)
  return ((b[0]! >>> 5) * 2 ** 26 + (b[1]! >>> 6)) / 2 ** 53
}

export const payoutFor = (amount: number, multiplier: number): number =>
  Math.floor((amount * Math.round(multiplier * 100)) / 100)

// Bots may be at most `botPct`% of the seats: B <= pct*(H+B)/100.
export const maxBotsFor = (humans: number, botPct: number, seats: number): number =>
  Math.max(0, Math.min(Math.floor((botPct * humans) / (100 - botPct)), seats - humans))

// Names come from the network and are drawn in a terminal: letters, digits and
// a few marks only. No control characters, no escapes.
export function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return text
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
}

// ---- types ----------------------------------------------------------------

export type Account = {
  id: string
  secretHash: string
  /** Hashes of keys handed to browsers, so the mod's own secret never leaves it. */
  webHashes?: string[]
  name: string
  balance: number
  createdAt: number
  lastSeenAt: number
  lastRefillAt: number
}

export type Bet = {
  amount: number
  auto: number | null // hidden from everyone but the owner
  cash: number | null // multiplier it was cashed at
  payout: number
}

export type Seat = {
  id: string
  name: string
  isBot: boolean
  bet: Bet | null
  lastSeen: number
  showAt: number // bots: ms into the betting phase when their bet appears
}

export type Table = {
  id: string
  phase: Phase
  round: number
  phaseStart: number
  runStart: number
  crashedAt: number
  crashPoint: number // secret until the table has crashed
  crashMs: number
  humans: Map<string, Seat>
  bots: Seat[]
  history: number[]
  emptySince: number | null
}

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

export type ActionError =
  | 'not-seated'
  | 'closed'
  | 'already-bet'
  | 'no-bet'
  | 'bad-amount'
  | 'bad-auto'
  | 'poor'
  | 'too-late'
  | 'locked'

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ActionError }

const BOT_NAMES = [
  'Nova', 'Pixel', 'Rusty', 'Mochi', 'Zed', 'Orbit', 'Juno', 'Kiwi', 'Bolt', 'Echo',
  'Fable', 'Gizmo', 'Hex', 'Ivy', 'Jett', 'Koda', 'Luna', 'Milo', 'Nix', 'Otto',
  'Pip', 'Quill', 'Rex', 'Sol', 'Tux', 'Uma', 'Vex', 'Wren', 'Yuki', 'Zoe',
]
const BOT_STAKES = [10, 10, 20, 20, 50, 50, 100, 100, 200, 500]

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

// ---- game -----------------------------------------------------------------

export class Game {
  accounts = new Map<string, Account>()
  tables = new Map<string, Table>()
  seatOf = new Map<string, string>() // account id -> table id
  isDirty = false
  private tableSeq = 0
  private botSeq = 0
  /** Account id -> session id -> when that session's last heartbeat stops counting. Not kept on disk. */
  private workingUntil = new Map<string, Map<string, number>>()
  private links = new Map<string, { accountId: string; until: number }>()

  constructor(
    readonly cfg: Config = DEFAULTS,
    private rand: () => number = secureRandom,
  ) {}

  // -- accounts --

  /** Makes an account, or null when the server is full of them. */
  createAccount(name: string, now: number): { account: Account; secret: string } | null {
    if (this.accounts.size >= this.cfg.maxAccounts) return null
    const id = randomBytes(8).toString('hex')
    const secret = randomBytes(16).toString('hex')
    const account: Account = {
      id,
      secretHash: hashSecret(secret),
      name: sanitizeName(name) || `Guest${Math.floor(this.rand() * 9000 + 1000)}`,
      balance: this.cfg.startBalance,
      createdAt: now,
      lastSeenAt: now,
      lastRefillAt: 0,
    }
    this.accounts.set(id, account)
    this.isDirty = true
    return { account, secret }
  }

  authenticate(id: unknown, secret: unknown): Account | null {
    if (typeof id !== 'string' || typeof secret !== 'string') return null
    const account = this.accounts.get(id)
    if (!account) return null
    const given = Buffer.from(hashSecret(secret))
    for (const hash of [account.secretHash, ...(account.webHashes ?? [])]) {
      const stored = Buffer.from(hash)
      if (given.length === stored.length && timingSafeEqual(given, stored)) return account
    }
    return null
  }

  // -- Claude is working --

  /**
   * A Claude Code session says whether it is working. Betting is open while any
   * session of the account is. When the last one stops, an open bet is settled
   * the way leaving does: cashed out if the plane is still flying, refunded if
   * betting is still open.
   */
  setWorking(
    accountId: string,
    working: boolean,
    now: number,
    sessionId = 'default',
  ): { refunded: number; cashed: number } | null {
    let sessions = this.workingUntil.get(accountId)
    if (working) {
      if (!sessions) this.workingUntil.set(accountId, (sessions = new Map()))
      sessions.set(sessionId, now + this.cfg.presenceMs)
      return null
    }
    sessions?.delete(sessionId)
    if (this.isWorking(accountId, now)) return null
    this.workingUntil.delete(accountId)
    return this.leave(accountId, now)
  }

  isWorking(accountId: string, now: number): boolean {
    for (const until of this.workingUntil.get(accountId)?.values() ?? []) if (until > now) return true
    return false
  }

  // -- opening the page --

  /** A one-time code the mod puts in the page's URL. */
  createLink(accountId: string, now: number): string {
    const code = randomBytes(9).toString('base64url')
    this.links.set(code, { accountId, until: now + this.cfg.linkMs })
    return code
  }

  /** Trades a code for a key of the browser's own. The code works once. */
  redeemLink(code: unknown, now: number): { account: Account; secret: string } | null {
    if (typeof code !== 'string') return null
    const link = this.links.get(code)
    this.links.delete(code)
    if (!link || link.until <= now) return null
    const account = this.accounts.get(link.accountId)
    if (!account) return null
    const secret = randomBytes(16).toString('hex')
    account.webHashes = [...(account.webHashes ?? []), hashSecret(secret)].slice(-5)
    this.isDirty = true
    return { account, secret }
  }

  rename(account: Account, name: string): void {
    const clean = sanitizeName(name)
    if (!clean || clean === account.name) return
    account.name = clean
    const seat = this.seatFor(account.id)
    if (seat) seat.name = clean
    this.isDirty = true
  }

  /** Drops accounts nobody has used for a long time, unless they are playing right now. */
  pruneAccounts(now: number): number {
    let dropped = 0
    for (const [id, account] of this.accounts) {
      if (now - account.lastSeenAt > this.cfg.idleAccountMs && !this.seatOf.has(id)) {
        this.accounts.delete(id)
        dropped += 1
      }
    }
    if (dropped > 0) this.isDirty = true
    return dropped
  }

  leaderboard(now: number, limit = 10): { name: string; balance: number }[] {
    const fortnight = 14 * 24 * 3600_000
    return [...this.accounts.values()]
      .filter(a => now - a.lastSeenAt < fortnight)
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit)
      .map(a => ({ name: a.name, balance: a.balance }))
  }

  // -- seating --

  join(account: Account, now: number): Table {
    const existing = this.tableOf(account.id)
    if (existing) {
      this.touch(account, now)
      return existing
    }
    let best: Table | undefined
    for (const t of this.tables.values()) {
      if (t.humans.size < this.cfg.seats && (!best || t.humans.size > best.humans.size)) best = t
    }
    const table = best ?? this.newTable(now)
    table.humans.set(account.id, {
      id: account.id,
      name: account.name,
      isBot: false,
      bet: null,
      lastSeen: now,
      showAt: 0,
    })
    table.emptySince = null
    this.seatOf.set(account.id, table.id)
    this.trimBots(table)
    this.touch(account, now)
    return table
  }

  /** Cashes out or refunds an open bet as far as the rules allow, then frees the seat. */
  leave(accountId: string, now: number): { refunded: number; cashed: number } {
    const table = this.tableOf(accountId)
    const seat = table?.humans.get(accountId)
    const out = { refunded: 0, cashed: 0 }
    if (!table || !seat) return out
    this.advance(table, now)
    if (seat.bet && seat.bet.cash === null) {
      if (table.phase === 'betting') {
        this.credit(accountId, seat.bet.amount)
        out.refunded = seat.bet.amount
        seat.bet = null
      } else if (table.phase === 'running') {
        const cashed = this.cashOut(table, seat, now)
        if (cashed.ok) out.cashed = cashed.payout
      }
    }
    table.humans.delete(accountId)
    this.seatOf.delete(accountId)
    this.trimBots(table)
    return out
  }

  // -- player actions --

  bet(accountId: string, amount: unknown, auto: unknown, now: number): Result<{ amount: number }> {
    const table = this.tableOf(accountId)
    const seat = table?.humans.get(accountId)
    const account = this.accounts.get(accountId)
    if (!table || !seat || !account) return { ok: false, error: 'not-seated' }
    this.advance(table, now)
    if (!this.isWorking(accountId, now)) return { ok: false, error: 'locked' }
    if (table.phase !== 'betting') return { ok: false, error: 'closed' }
    if (seat.bet) return { ok: false, error: 'already-bet' }
    if (!Number.isInteger(amount) || (amount as number) < this.cfg.minBet || (amount as number) > this.cfg.maxBet) {
      return { ok: false, error: 'bad-amount' }
    }
    let target: number | null = null
    if (auto !== null && auto !== undefined) {
      if (typeof auto !== 'number' || !Number.isFinite(auto) || auto < 1.01 || auto > this.cfg.maxMultiplier) {
        return { ok: false, error: 'bad-auto' }
      }
      target = Math.floor(auto * 100) / 100
    }
    const stake = amount as number
    if (stake > account.balance) return { ok: false, error: 'poor' }
    account.balance -= stake
    seat.bet = { amount: stake, auto: target, cash: null, payout: 0 }
    this.isDirty = true
    return { ok: true, amount: stake }
  }

  cashout(accountId: string, now: number): Result<{ multiplier: number; payout: number }> {
    const table = this.tableOf(accountId)
    const seat = table?.humans.get(accountId)
    if (!table || !seat) return { ok: false, error: 'not-seated' }
    this.advance(table, now)
    if (!seat.bet || seat.bet.cash !== null) return { ok: false, error: 'no-bet' }
    if (table.phase !== 'running') return { ok: false, error: table.phase === 'crashed' ? 'too-late' : 'closed' }
    return this.cashOut(table, seat, now)
  }

  /** Marks the player as present; tops up a broke player once in a while. */
  touch(account: Account, now: number): void {
    account.lastSeenAt = now
    const seat = this.seatFor(account.id)
    if (seat) seat.lastSeen = now
    const hasBet = !!seat?.bet && seat.bet.cash === null
    if (
      account.balance < this.cfg.refillBelow &&
      !hasBet &&
      now - account.lastRefillAt >= this.cfg.refillEveryMs
    ) {
      account.balance = this.cfg.refillTo
      account.lastRefillAt = now
      this.isDirty = true
    }
  }

  // -- time --

  tick(now: number): void {
    for (const [id, sessions] of [...this.workingUntil]) {
      for (const [session, until] of sessions) if (until <= now) sessions.delete(session)
      if (sessions.size === 0) {
        this.workingUntil.delete(id)
        this.leave(id, now)
      }
    }
    for (const [code, link] of this.links) if (link.until <= now) this.links.delete(code)
    for (const table of [...this.tables.values()]) {
      for (const seat of [...table.humans.values()]) {
        if (now - seat.lastSeen > this.cfg.idleKickMs) this.leave(seat.id, now)
      }
      if (table.humans.size === 0) {
        table.emptySince ??= now
        if (now - table.emptySince > this.cfg.emptyTableMs) this.tables.delete(table.id)
        continue
      }
      this.advance(table, now)
    }
  }

  // -- view --

  snapshot(accountId: string, now: number): Snapshot | null {
    const table = this.tableOf(accountId)
    const account = this.accounts.get(accountId)
    if (!table || !account) return null
    this.advance(table, now)
    const seats = [...table.humans.values(), ...table.bots]
    const inBetting = table.phase === 'betting'
    const players: Row[] = seats.map(s => {
      const visible = !s.isBot || !inBetting || now - table.phaseStart >= s.showAt
      const bet = visible ? s.bet : null
      return {
        name: s.name,
        bot: s.isBot,
        you: s.id === accountId,
        bet: bet?.amount ?? 0,
        cash: bet?.cash ?? null,
        payout: bet?.payout ?? 0,
      }
    })
    players.sort((a, b) => Number(b.you) - Number(a.you) || b.bet - a.bet || a.name.localeCompare(b.name))
    const mine = table.humans.get(accountId)?.bet ?? null
    const isCrashed = table.phase === 'crashed'
    return {
      now,
      growth: this.cfg.growth,
      table: {
        id: table.id,
        round: table.round,
        phase: table.phase,
        phaseStartedAt: table.phaseStart,
        bettingEndsAt: table.phaseStart + this.cfg.bettingMs,
        runStartedAt: table.phase === 'betting' ? null : table.runStart,
        crashedAt: isCrashed ? table.crashedAt : null,
        crashPoint: isCrashed ? table.crashPoint : null,
        humans: table.humans.size,
        bots: table.bots.length,
      },
      players,
      history: table.history,
      you: {
        name: account.name,
        balance: account.balance,
        bet: mine ? { amount: mine.amount, auto: mine.auto, cash: mine.cash, payout: mine.payout } : null,
        refillAt:
          account.balance < this.cfg.refillBelow && !mine
            ? Math.max(now, account.lastRefillAt + this.cfg.refillEveryMs)
            : null,
      },
      limits: { minBet: this.cfg.minBet, maxBet: this.cfg.maxBet },
    }
  }

  // -- internals --

  private tableOf(accountId: string): Table | undefined {
    const id = this.seatOf.get(accountId)
    return id ? this.tables.get(id) : undefined
  }

  private seatFor(accountId: string): Seat | undefined {
    return this.tableOf(accountId)?.humans.get(accountId)
  }

  private newTable(now: number): Table {
    const table: Table = {
      id: `t${++this.tableSeq}`,
      phase: 'betting',
      round: 1,
      phaseStart: now,
      runStart: 0,
      crashedAt: 0,
      crashPoint: 0,
      crashMs: 0,
      humans: new Map(),
      bots: [],
      history: [],
      emptySince: null,
    }
    this.tables.set(table.id, table)
    return table
  }

  private credit(accountId: string, amount: number): void {
    const account = this.accounts.get(accountId)
    if (!account) return
    account.balance += amount
    this.isDirty = true
  }

  private trimBots(table: Table): void {
    const max = maxBotsFor(table.humans.size, this.cfg.botPct, this.cfg.seats)
    if (table.bots.length > max) table.bots.length = max
  }

  private cashOut(table: Table, seat: Seat, now: number): Result<{ multiplier: number; payout: number }> {
    const bet = seat.bet
    if (!bet || bet.cash !== null) return { ok: false, error: 'no-bet' }
    const elapsed = now - table.runStart
    if (elapsed >= table.crashMs) return { ok: false, error: 'too-late' }
    return { ok: true, ...this.settle(seat, bet, multiplierAt(elapsed, this.cfg.growth)) }
  }

  private settle(seat: Seat, bet: Bet, multiplier: number): { multiplier: number; payout: number } {
    bet.cash = multiplier
    bet.payout = payoutFor(bet.amount, multiplier)
    if (!seat.isBot) this.credit(seat.id, bet.payout)
    return { multiplier, payout: bet.payout }
  }

  private advance(table: Table, now: number): void {
    const { cfg } = this
    if (table.phase === 'betting' && now >= table.phaseStart + cfg.bettingMs) {
      table.phase = 'running'
      table.runStart = table.phaseStart + cfg.bettingMs
      table.crashPoint = rollCrashPoint(this.rand, cfg.edgePct, cfg.maxMultiplier)
      table.crashMs = crashMsFor(table.crashPoint, cfg.growth)
    }
    if (table.phase === 'running') {
      const elapsed = now - table.runStart
      for (const seat of [...table.humans.values(), ...table.bots]) {
        const bet = seat.bet
        if (!bet || bet.cash !== null || bet.auto === null) continue
        if (bet.auto <= table.crashPoint && elapsed >= msToReach(bet.auto, cfg.growth)) {
          this.settle(seat, bet, bet.auto)
        }
      }
      if (elapsed >= table.crashMs) {
        table.phase = 'crashed'
        table.crashedAt = table.runStart + table.crashMs
        table.history = [table.crashPoint, ...table.history].slice(0, 12)
      }
    }
    if (table.phase === 'crashed' && now >= table.crashedAt + cfg.crashedMs) {
      this.startBetting(table, now)
    }
  }

  private startBetting(table: Table, now: number): void {
    table.phase = 'betting'
    table.round += 1
    table.phaseStart = now
    for (const seat of table.humans.values()) seat.bet = null
    this.trimBots(table)
    const want = maxBotsFor(table.humans.size, this.cfg.botPct, this.cfg.seats)
    while (table.bots.length < want) {
      const taken = new Set(table.bots.map(b => b.name))
      const free = BOT_NAMES.filter(n => !taken.has(n))
      const name = free[Math.floor(this.rand() * free.length)] ?? `Bot${this.botSeq}`
      table.bots.push({ id: `bot${++this.botSeq}`, name, isBot: true, bet: null, lastSeen: now, showAt: 0 })
    }
    for (const bot of table.bots) {
      const isPlaying = this.rand() < 0.85
      bot.showAt = 500 + this.rand() * (this.cfg.bettingMs - 2500)
      if (!isPlaying) {
        bot.bet = null
        continue
      }
      const amount = BOT_STAKES[Math.floor(this.rand() * BOT_STAKES.length)]!
      const target = Math.min(50, Math.max(1.1, 1 + -Math.log(1 - this.rand()) * 1.4))
      bot.bet = { amount, auto: Math.floor(target * 100) / 100, cash: null, payout: 0 }
    }
  }

  // -- persistence --

  exportAccounts(): Account[] {
    return [...this.accounts.values()]
  }

  importAccounts(list: Account[]): void {
    for (const a of list) {
      if (a && typeof a.id === 'string' && typeof a.secretHash === 'string') this.accounts.set(a.id, a)
    }
  }
}
