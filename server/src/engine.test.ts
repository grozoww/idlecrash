import { describe, expect, test } from 'bun:test'
import {
  DEFAULTS,
  Game,
  crashMsFor,
  maxBotsFor,
  multiplierAt,
  msToReach,
  payoutFor,
  rollCrashPoint,
  sanitizeName,
  type Config,
} from './engine'

// A repeatable "random" source.
function seeded(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const T0 = 1_000_000

function setup(over: Partial<Config> = {}, rand = seeded(7)) {
  // Presence never lapses here unless a test asks for it: the rounds below run for minutes.
  const game = new Game({ ...DEFAULTS, presenceMs: 1e12, ...over }, rand)
  const join = (name: string, now = T0) => {
    const { account } = game.createAccount(name, now)!
    game.setWorking(account.id, true, now)
    game.join(account, now)
    return account
  }
  return { game, join }
}

// Forces the next crash point by feeding rollCrashPoint a chosen random value.
const crashAt = (point: number, edge = 1): number => 1 - (100 - edge) / 100 / point

describe('math', () => {
  test('multiplier grows from 1.00 and is monotonic', () => {
    expect(multiplierAt(0, 0.12)).toBe(1)
    let last = 1
    for (let ms = 0; ms < 60_000; ms += 100) {
      const m = multiplierAt(ms, 0.12)
      expect(m).toBeGreaterThanOrEqual(last)
      last = m
    }
    expect(multiplierAt(5800, 0.12)).toBeCloseTo(2, 1)
  })

  test('crash point follows P(>= x) = 0.99 / x', () => {
    const rand = seeded(42)
    const n = 200_000
    const points = Array.from({ length: n }, () => rollCrashPoint(rand, 1, 1000))
    const share = (x: number) => points.filter(p => p >= x).length / n
    expect(share(2)).toBeCloseTo(0.495, 1)
    expect(share(10)).toBeCloseTo(0.099, 2)
    expect(Math.min(...points)).toBe(1)
  })

  test('a 1.00 crash ends at once, others end after the multiplier shows the crash point', () => {
    expect(crashMsFor(1, 0.12)).toBe(0)
    const ms = crashMsFor(2.5, 0.12)
    expect(multiplierAt(ms - 1, 0.12)).toBe(2.5)
  })

  test('payout is an integer and never more than amount * multiplier', () => {
    expect(payoutFor(100, 1.5)).toBe(150)
    expect(payoutFor(33, 1.57)).toBe(51)
  })
})

describe('bots', () => {
  test('never more than 30% of the seats, and none for one or two humans', () => {
    for (let humans = 1; humans <= 10; humans++) {
      const bots = maxBotsFor(humans, 30, 10)
      expect(bots + humans).toBeLessThanOrEqual(10)
      if (bots > 0) expect(bots / (bots + humans)).toBeLessThanOrEqual(0.3)
    }
    expect(maxBotsFor(1, 30, 10)).toBe(0)
    expect(maxBotsFor(2, 30, 10)).toBe(0)
    expect(maxBotsFor(3, 30, 10)).toBe(1)
    expect(maxBotsFor(7, 30, 10)).toBe(3)
  })

  test('a table seats them at the next round and drops extras at once when people leave', () => {
    const { game, join } = setup()
    const people = Array.from({ length: 7 }, (_, i) => join(`p${i}`))
    const table = [...game.tables.values()][0]!
    expect(table.bots.length).toBe(0) // first round: none yet
    let now = T0
    while (table.round < 2) {
      for (const p of people) game.touch(p, now) // keep everyone present
      game.tick((now += 50))
    }
    expect(table.round).toBeGreaterThanOrEqual(2)
    expect(table.bots.length).toBe(3)
    game.leave(people[0]!.id, now)
    expect(table.bots.length).toBeLessThanOrEqual(maxBotsFor(6, 30, 10))
  })

  test('the snapshot hides the crash point and other players\' auto targets while flying', () => {
    const { game, join } = setup()
    for (let i = 0; i < 7; i++) join(`p${i}`)
    const table = [...game.tables.values()][0]!
    const me = [...game.accounts.values()][0]!
    let now = T0
    while (table.round < 2) {
      for (const a of game.accounts.values()) game.touch(a, now)
      game.tick((now += 50))
    }
    expect(table.bots.some(b => b.bet?.auto != null)).toBe(true)
    // run the flight and look at every snapshot on the way
    const flightStart = table.phaseStart + DEFAULTS.bettingMs
    for (now = flightStart; table.phase !== 'crashed'; now += 50) {
      for (const a of game.accounts.values()) game.touch(a, now)
      game.tick(now)
      const snap = game.snapshot(me.id, now)!
      if (snap.table.phase !== 'crashed') expect(snap.table.crashPoint).toBeNull()
      for (const row of snap.players) expect('auto' in row).toBe(false)
    }
    expect(game.snapshot(me.id, now)!.table.crashPoint).toBe(table.crashPoint)
  })
})

describe('rounds', () => {
  test('betting -> running -> crashed -> betting', () => {
    const { game, join } = setup()
    const a = join('ann')
    const table = [...game.tables.values()][0]!
    expect(table.phase).toBe('betting')
    game.touch(a, T0 + 8000)
    game.tick(T0 + 8000)
    expect(table.phase).toBe('running')
    game.touch(a, T0 + 8000 + table.crashMs + 1)
    game.tick(T0 + 8000 + table.crashMs + 1)
    expect(table.phase).toBe('crashed')
    expect(table.history[0]).toBe(table.crashPoint)
    game.tick(table.crashedAt + DEFAULTS.crashedMs)
    expect(table.phase).toBe('betting')
    expect(table.round).toBe(2)
  })

  test('bet, then cash out in time: balance goes up by the payout', () => {
    // r chosen so the crash point is 5.00
    const { game, join } = setup({}, () => crashAt(5))
    const a = join('ann')
    expect(game.bet(a.id, 100, null, T0 + 100)).toEqual({ ok: true, amount: 100 })
    expect(a.balance).toBe(900)
    const runStart = T0 + 8000
    const res = game.cashout(a.id, runStart + 3000)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.multiplier).toBe(multiplierAt(3000, 0.12))
      expect(a.balance).toBe(900 + res.payout)
    }
  })

  test('cash out too late: the bet is lost', () => {
    const { game, join } = setup({}, () => crashAt(1.5))
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 100)
    const late = T0 + 8000 + msToReach(1.51, 0.12) + 50
    expect(game.cashout(a.id, late)).toEqual({ ok: false, error: 'too-late' })
    expect(a.balance).toBe(900)
  })

  test('auto cash-out pays exactly the target, and only if the crash point reaches it', () => {
    const { game, join } = setup({}, () => crashAt(3))
    const a = join('ann')
    const b = join('bob')
    game.bet(a.id, 100, 2, T0 + 100) // wins at 2.00
    game.bet(b.id, 100, 4, T0 + 100) // crash at 3.00 first
    const end = T0 + 8000 + 60_000
    for (const p of [a, b]) game.touch(p, end)
    game.tick(end)
    expect(a.balance).toBe(900 + 200)
    expect(b.balance).toBe(900)
  })

  test('50 on 2.00x pays 100 in total: balance 1050, profit 50, not a refund of the stake', () => {
    const { game, join } = setup({}, () => crashAt(5))
    const auto = join('auto')
    const manual = join('manual')
    game.bet(auto.id, 50, 2, T0 + 100)
    game.bet(manual.id, 50, null, T0 + 100)
    expect(auto.balance).toBe(950)
    // flying: the auto bet is paid when the curve reaches 2.00x, the manual one when asked
    const at2 = T0 + 8000 + msToReach(2, 0.12) + 5
    game.touch(auto, at2)
    game.touch(manual, at2)
    game.tick(at2)
    expect(auto.balance).toBe(1050)
    const res = game.cashout(manual.id, at2)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.multiplier).toBe(2)
      expect(res.payout).toBe(100)
    }
    expect(manual.balance).toBe(1050)
    const row = game.snapshot(auto.id, at2)!.players.find(p => p.you)!
    expect(row.bet).toBe(50)
    expect(row.cash).toBe(2)
    expect(row.payout).toBe(100)
  })

  test('betting rules', () => {
    const { game, join } = setup()
    const a = join('ann')
    expect(game.bet(a.id, 5, null, T0)).toEqual({ ok: false, error: 'bad-amount' })
    expect(game.bet(a.id, 10_000, null, T0)).toEqual({ ok: false, error: 'bad-amount' })
    expect(game.bet(a.id, 50, 1.0, T0)).toEqual({ ok: false, error: 'bad-auto' })
    expect(game.bet(a.id, 50, null, T0).ok).toBe(true)
    expect(game.bet(a.id, 50, null, T0)).toEqual({ ok: false, error: 'already-bet' })
    a.balance = 0
    game.leave(a.id, T0)
    expect(game.bet(a.id, 50, null, T0)).toEqual({ ok: false, error: 'not-seated' })
  })

  test('no bets after the betting window closes', () => {
    const { game, join } = setup()
    const a = join('ann')
    expect(game.bet(a.id, 50, null, T0 + 8000)).toEqual({ ok: false, error: 'closed' })
  })
})

describe('leaving', () => {
  test('leaving during betting refunds the stake', () => {
    const { game, join } = setup()
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 10)
    expect(a.balance).toBe(900)
    expect(game.leave(a.id, T0 + 20)).toEqual({ refunded: 100, cashed: 0 })
    expect(a.balance).toBe(1000)
  })

  test('leaving mid-flight cashes out at the current multiplier', () => {
    const { game, join } = setup({}, () => crashAt(20))
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 10)
    const out = game.leave(a.id, T0 + 8000 + 4000)
    expect(out.cashed).toBe(payoutFor(100, multiplierAt(4000, 0.12)))
    expect(a.balance).toBe(900 + out.cashed)
  })

  test('a player who stops polling is removed and the empty table goes away', () => {
    const { game, join } = setup()
    const a = join('ann')
    game.tick(T0 + DEFAULTS.idleKickMs + 1)
    expect(game.snapshot(a.id, T0 + DEFAULTS.idleKickMs + 1)).toBeNull()
    game.tick(T0 + DEFAULTS.idleKickMs + DEFAULTS.emptyTableMs + 100)
    expect(game.tables.size).toBe(0)
  })
})

describe('Claude is working', () => {
  const realPresence = { presenceMs: DEFAULTS.presenceMs }

  test('no bets while Claude is not working', () => {
    const { game } = setup(realPresence)
    const { account } = game.createAccount('ann', T0)!
    game.join(account, T0)
    expect(game.bet(account.id, 50, null, T0)).toEqual({ ok: false, error: 'locked' })
    game.setWorking(account.id, true, T0)
    expect(game.bet(account.id, 50, null, T0).ok).toBe(true)
  })

  test('no heartbeat for a while: locked for new bets, and an open bet stays in its round', () => {
    const { game } = setup(realPresence)
    const { account } = game.createAccount('ann', T0)!
    game.setWorking(account.id, true, T0)
    game.join(account, T0)
    game.bet(account.id, 50, null, T0 + 100)
    game.touch(account, T0 + 5000)
    game.tick(T0 + DEFAULTS.presenceMs + 1)
    expect(game.isWorking(account.id, T0 + DEFAULTS.presenceMs + 1)).toBe(false)
    expect(account.balance).toBe(950) // the bet stands: it is not refunded
    // the seat stays to watch the round out, and nothing can be bet from it
    expect(game.snapshot(account.id, T0 + DEFAULTS.presenceMs + 1)).not.toBeNull()
    expect(game.bet(account.id, 50, null, T0 + DEFAULTS.presenceMs + 2)).toEqual({ ok: false, error: 'locked' })
  })

  test('a heartbeat keeps it on', () => {
    const { game } = setup(realPresence)
    const { account } = game.createAccount('ann', T0)!
    game.setWorking(account.id, true, T0)
    game.setWorking(account.id, true, T0 + 6000)
    expect(game.isWorking(account.id, T0 + 12_000)).toBe(true)
  })

  test('when the turn ends mid-flight the open bet stays, and can be cashed out at the multiplier of the moment', () => {
    const { game, join } = setup({}, () => crashAt(20))
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 10)
    const out = game.setWorking(a.id, false, T0 + 8000 + 4000)
    expect(out).toEqual({ refunded: 0, cashed: 0 }) // nothing was settled for the player
    expect(a.balance).toBe(900)
    expect(game.bet(a.id, 50, null, T0 + 8000 + 4500)).toEqual({ ok: false, error: 'locked' })

    const cashed = game.cashout(a.id, T0 + 8000 + 6000)
    expect(cashed).toMatchObject({ ok: true, payout: payoutFor(100, multiplierAt(6000, 0.12)) })
    expect(a.balance).toBe(900 + payoutFor(100, multiplierAt(6000, 0.12)))
  })

  test('a bet that is still open at the crash after Claude stopped is lost', () => {
    const { game, join } = setup({}, () => crashAt(2))
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 10)
    game.setWorking(a.id, false, T0 + 8000 + 500)
    const crashed = T0 + 8000 + 6500 // the plane went at 2.00x, 5.8 s into the flight, and the table shows the crash for 4 s more
    expect(game.cashout(a.id, crashed)).toEqual({ ok: false, error: 'too-late' })
    expect(a.balance).toBe(900) // the stake is lost
  })

  test('two sessions: one finishing does not lock the other', () => {
    const { game } = setup(realPresence)
    const { account } = game.createAccount('ann', T0)!
    game.join(account, T0)
    game.setWorking(account.id, true, T0, 'a')
    game.setWorking(account.id, true, T0, 'b')
    game.bet(account.id, 50, null, T0 + 100)
    expect(game.setWorking(account.id, false, T0 + 500, 'a')).toBeNull() // b is still working
    expect(game.isWorking(account.id, T0 + 600)).toBe(true)
    expect(account.balance).toBe(950) // the bet stands
    const out = game.setWorking(account.id, false, T0 + 700, 'b')
    expect(out).toEqual({ refunded: 0, cashed: 0 }) // the bet is still in: it is not refunded
    expect(account.balance).toBe(950)
    expect(game.isWorking(account.id, T0 + 800)).toBe(false)
  })

  test('a session that goes quiet stops counting, the other keeps the table open', () => {
    const { game } = setup(realPresence)
    const { account } = game.createAccount('ann', T0)!
    game.setWorking(account.id, true, T0, 'a')
    game.setWorking(account.id, true, T0 + 6000, 'b')
    game.tick(T0 + DEFAULTS.presenceMs + 100)
    expect(game.isWorking(account.id, T0 + DEFAULTS.presenceMs + 100)).toBe(true)
  })

  test('cashing out never needs Claude to be working', () => {
    const { game, join } = setup({}, () => crashAt(20))
    const a = join('ann')
    game.bet(a.id, 100, null, T0 + 10)
    game.setWorking(a.id, true, T0 + 8000 + 100) // still on
    expect(game.cashout(a.id, T0 + 8000 + 3000).ok).toBe(true)
  })
})

describe('limits', () => {
  test('no more accounts than the cap', () => {
    const { game } = setup({ maxAccounts: 2 })
    expect(game.createAccount('a', T0)).not.toBeNull()
    expect(game.createAccount('b', T0)).not.toBeNull()
    expect(game.createAccount('c', T0)).toBeNull()
  })

  test('accounts nobody uses are dropped after a long time, players at a table are not', () => {
    const { game } = setup()
    const idle = game.createAccount('idle', T0)!.account
    const playing = game.createAccount('playing', T0)!.account
    game.join(playing, T0)
    const later = T0 + DEFAULTS.idleAccountMs + 1
    expect(game.pruneAccounts(later)).toBe(1)
    expect(game.accounts.has(idle.id)).toBe(false)
    expect(game.accounts.has(playing.id)).toBe(true)
    expect(game.isDirty).toBe(true)
  })
})

describe('watching the round out', () => {
  const watcher = () => {
    const w = setup({}, () => crashAt(3))
    const a = w.join('ann')
    return { ...w, a }
  }

  test('after Claude stops, the table stays on screen through the flight and the crash, then the seat goes', () => {
    const { game, a } = watcher()
    game.bet(a.id, 100, null, T0 + 10)
    const flying = T0 + 8000 + 1000
    const out = game.setWorking(a.id, false, flying)
    expect(out?.cashed).toBe(0) // nothing was cashed out for them
    expect(game.snapshot(a.id, flying)?.table.phase).toBe('running')
    expect(game.snapshot(a.id, flying)?.you.bet?.cash).toBeNull() // the bet is still open

    const crashAfter = T0 + 8000 + 10_000 // the crash is at about 9.2 s into the flight
    game.touch(a, crashAfter)
    const seen = game.snapshot(a.id, crashAfter)
    expect(seen?.table.phase).toBe('crashed') // still watching it
    expect(seen?.table.crashPoint).toBeGreaterThan(2.9)
    expect(seen?.table.crashPoint).toBeLessThan(3.1)

    const nextRound = crashAfter + DEFAULTS.crashedMs + 50
    game.touch(a, nextRound)
    game.tick(nextRound)
    expect(game.snapshot(a.id, nextRound)).toBeNull() // the new round does not include a watcher
    expect(game.bet(a.id, 50, null, nextRound)).toEqual({ ok: false, error: 'locked' })
  })

  test('a watcher does not count as working, cannot bet, and is paid once, by hand or by the auto target', () => {
    const { game, a } = watcher()
    game.bet(a.id, 100, 2, T0 + 10)
    game.setWorking(a.id, false, T0 + 8000 + 500) // before 2.00x: nothing is cashed out now
    expect(a.balance).toBe(900)
    expect(game.bet(a.id, 50, null, T0 + 8000 + 600)).toEqual({ ok: false, error: 'locked' })
    game.touch(a, T0 + 8000 + 6000)
    game.tick(T0 + 8000 + 6000) // the plane passes the auto target 2.00x (crash at 3.00x), and it pays
    expect(a.balance).toBe(900 + payoutFor(100, 2))
    const balance = a.balance
    game.touch(a, T0 + 8000 + 10_000)
    game.tick(T0 + 8000 + 10_000)
    expect(a.balance).toBe(balance) // and not again
    expect(game.cashout(a.id, T0 + 8000 + 6500).ok).toBe(false) // nothing left to cash out
  })

  test('a watcher who leaves still has the open bet settled as before', () => {
    const { game, a } = watcher()
    game.bet(a.id, 100, null, T0 + 10)
    game.setWorking(a.id, false, T0 + 8000 + 4000)
    const out = game.leave(a.id, T0 + 8000 + 4500)
    expect(out.cashed).toBe(payoutFor(100, multiplierAt(4500, 0.12)))
    expect(a.balance).toBe(900 + out.cashed)
  })

  test('if Claude is back before the round ends, the player keeps the seat', () => {
    const { game, a } = watcher()
    game.setWorking(a.id, false, T0 + 100)
    game.setWorking(a.id, true, T0 + 200)
    const later = T0 + 8000 + 60_000 // many rounds later
    game.touch(a, later) // the page is still asking
    game.tick(later)
    expect(game.snapshot(a.id, later)).not.toBeNull()
  })

  test('a watching player is not kicked while their page keeps asking', () => {
    const { game, a } = watcher()
    game.setWorking(a.id, false, T0 + 100)
    for (let t = T0 + 1000; t < T0 + 8000; t += 1000) {
      game.touch(a, t)
      game.tick(t)
    }
    expect(game.snapshot(a.id, T0 + 8000 - 1)).not.toBeNull()
  })
})

describe('the secret', () => {
  test('is checked against its hash, and only the hash is kept', () => {
    const { game } = setup()
    const { account, secret } = game.createAccount('ann', T0)!
    expect(game.authenticate(account.id, secret)).toBe(account)
    expect(game.authenticate(account.id, 'wrong')).toBeNull()
    expect(game.authenticate('nobody', secret)).toBeNull()
    expect(game.authenticate(42, secret)).toBeNull()
    expect(JSON.stringify(game.exportAccounts())).not.toContain(secret)
  })

  test('keys that were handed to a browser, in an accounts file from the days of the page, are dropped on load', () => {
    const { game } = setup()
    const { account, secret } = game.createAccount('ann', T0)!
    const old = { ...account, webHashes: ['abc'] }
    const fresh = setup().game
    fresh.importAccounts([old])
    expect(fresh.authenticate(account.id, secret)).not.toBeNull()
    expect(JSON.stringify(fresh.exportAccounts())).not.toContain('webHashes')
  })
})

describe('tables and accounts', () => {
  test('fills one table up to 10 seats, then opens a second', () => {
    const { game, join } = setup()
    for (let i = 0; i < 11; i++) join(`p${i}`)
    const sizes = [...game.tables.values()].map(t => t.humans.size).sort()
    expect(sizes).toEqual([1, 10])
  })

  test('secret check', () => {
    const { game } = setup()
    const { account, secret } = game.createAccount('ann', T0)!
    expect(game.authenticate(account.id, secret)).toBe(account)
    expect(game.authenticate(account.id, 'wrong')).toBeNull()
    expect(game.authenticate('nope', secret)).toBeNull()
    expect(JSON.stringify(game.exportAccounts())).not.toContain(secret)
  })

  test('a broke player gets a top-up once in a while, never mid-bet', () => {
    const { game, join } = setup()
    const a = join('ann')
    a.balance = 3
    game.touch(a, T0 + 1)
    expect(a.balance).toBe(DEFAULTS.refillTo)
    a.balance = 3
    game.touch(a, T0 + 2)
    expect(a.balance).toBe(3) // cooldown
  })

  test('names are cleaned of control characters and escapes', () => {
    expect(sanitizeName('\u001b[31mEvil\u001b[0m')).toBe('31mEvil0m')
    expect(sanitizeName('  a\u0000b\n c  ')).toBe('ab c')
    expect(sanitizeName('x'.repeat(40))).toHaveLength(16)
    expect(sanitizeName(42)).toBe('')
  })
})
