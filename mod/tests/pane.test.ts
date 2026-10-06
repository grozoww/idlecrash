// The terminal side: the game lives in a pane, drawn by a Client that animates on its own.
import { describe, expect, test } from 'claude-code/testing'

import { BASE, DONE, PANE_PROPS, START, paths, run, world } from './world'

const mount = ($: any, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal') =>
  $.ui.mount({ plugin: 'idlecrash', surface, component: 'Pane', requestId: 'idlecrash', props: PANE_PROPS })

describe('a turn on a terminal', () => {
  test('seats you, bets, cashes out, and locks when the turn ends', async ($, on) => {
    const { clock, calls, state, opened } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'build it', turnId: 't1' })
    await clock.advance(1500)
    expect(paths(calls)).toContain('POST /presence') // betting opens only while Claude works
    expect(paths(calls)).toContain('POST /join')
    expect(paths(calls)).toContain('GET /state')
    expect(opened).toHaveLength(0) // the pane is the game here: no browser

    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /BETS OPEN/, in: 'scene' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 bots/ })).toBeDefined()

    await ui.press({ key: 'bet' })
    expect(paths(calls)).toContain('POST /bet')
    expect(state.bet?.amount).toBe(50)
    expect(state.bet?.auto).toBe(2)
    expect(await ui.find({ key: 'bet' })).toBeUndefined()

    state.phase = 'running'
    state.phaseStart = clock.now() - 8000 - 3000
    await clock.advance(500)
    await ui.press({ key: 'cash' })
    expect(paths(calls)).toContain('POST /cashout')
    // 50 at 2.00x pays 100. The pane says what was paid, not just the profit.
    expect(await ui.find({ type: 'Text', text: /cashed out 2\.00x: paid 100/ })).toBeDefined()
    expect(state.balance).toBe(1050)

    await $.turn.complete(DONE)
    await clock.advance(50)
    const last = calls[calls.length - 1]!
    expect(last.path).toBe('/presence')
    expect(last.body.working).toBe(false) // the server settles the bet and unseats us
    expect(await ui.find({ type: 'Text', text: /betting is locked/ })).toBeDefined()
    expect(await ui.find({ key: 'bet' })).toBeUndefined()
    expect(await ui.find({ key: 'cash' })).toBeUndefined()
  })

  test('after the turn the round stays on screen to its end, without betting, then the summary comes', async ($, on) => {
    const { clock, calls, state } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const ui = await mount($)
    state.phase = 'running'
    state.phaseStart = clock.now() - 8000 - 2000
    await clock.advance(1100)

    await $.turn.complete(DONE)
    await clock.advance(1500)
    const afterFinish = calls.length
    expect(await ui.find({ type: 'Text', text: /Watching this round/ })).toBeDefined()
    expect(await ui.find({ key: 'bet' })).toBeUndefined()
    expect(await ui.find({ key: 'cash' })).toBeUndefined()
    expect(await ui.find({ key: 'auto' })).toBeUndefined() // nothing to set: it cannot bet
    expect(await ui.find({ type: 'Text', text: /CRASHED|BETS OPEN|▲/, in: 'scene' })).toBeDefined() // the picture is still there
    await clock.advance(3000)
    expect(paths(calls.slice(afterFinish))).toContain('GET /state') // still asking the server about the round
    expect(calls.slice(afterFinish).some(c => c.path === '/presence')).toBe(false) // but no longer beating

    state.roundOver = true // the server took the seat away
    await clock.advance(3000)
    expect(await ui.find({ type: 'Text', text: /betting is locked/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Watching this round/ })).toBeUndefined()
    const done = calls.length
    await clock.advance(10_000)
    expect(calls.length).toBe(done) // all quiet
  })

  test('a round that never ends is not watched for ever', async ($, on) => {
    const { clock, calls } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    await $.turn.complete(DONE)
    await clock.advance(125_000)
    const done = calls.length
    await clock.advance(10_000)
    expect(calls.length).toBe(done)
  })

  test('stops polling and beating once the turn is over', async ($, on) => {
    const { clock, calls } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    await $.turn.complete(DONE)
    await clock.advance(50)
    expect(calls.filter(c => c.path === '/presence' && c.body.working === true).length).toBeGreaterThan(0)
    const beats = () => calls.filter(c => c.path === '/presence' && c.body.working === true).length
    const before = beats()
    await clock.advance(10_000)
    expect(beats()).toBe(before) // no more "Claude is working"
  })

  test('a subagent finishing does not end the game', async ($, on) => {
    const { clock, calls } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    await $.turn.complete({ ...DONE, agentId: 'sub-1' })
    await clock.advance(50)
    expect(calls.some(c => c.body.working === false)).toBe(false)
  })

  test('a window too narrow for the pane plays in the browser instead', async ($, on) => {
    const { clock, calls, opened, toasts } = world(on, { surfaces: ['terminal'], isPlaced: false })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(5000)
    expect(paths(calls)).not.toContain('POST /join') // no seat for a pane nobody can see
    expect(opened).toEqual([['open', `${BASE}/?c=abcDEF123xyz`]])
    expect(toasts.some(t => /narrower than 144/.test(t))).toBe(true)
  })
})

describe('refusals are explained', () => {
  test('"locked" reads as words, not as a bare refusal', async ($, on) => {
    const { clock, state } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const ui = await mount($)
    state.refuse = 'locked'
    await ui.press({ key: 'bet' })
    expect(await ui.find({ type: 'Text', text: 'Claude is not working, betting is locked' })).toBeDefined()
  })

  test('a code we have no words for is shown, so a refusal can be reported', async ($, on) => {
    const { clock, state } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const ui = await mount($)
    state.refuse = 'weird-new-code'
    await ui.press({ key: 'bet' })
    expect(await ui.find({ type: 'Text', text: 'Bet refused (weird-new-code)' })).toBeDefined()
  })
})

describe('redraws', () => {
  test('a quiet table writes no state, so the buttons are never redrawn under the pointer', async ($, on) => {
    const { clock } = world(on, { surfaces: ['terminal'] })
    let writes = 0
    on('state.set', () => {
      writes += 1
      return { value: { isSet: true, version: writes } } as never
    })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const settled = writes
    await clock.advance(10_000)
    expect(writes).toBe(settled)
  })

  test('the picture moves on its own while the plugin tree stays the same', async ($, on) => {
    const { clock, state } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    state.phase = 'running'
    state.phaseStart = clock.now() - 8000 - 2000
    await clock.advance(1100)
    const ui = await mount($)
    const treeBefore = JSON.stringify(await ui.drawn())
    const pictureBefore = JSON.stringify(await ui.drawn({ in: 'scene' }))
    await ui.advance(500)
    expect(JSON.stringify(await ui.drawn({ in: 'scene' }))).not.toBe(pictureBefore)
    expect(JSON.stringify(await ui.drawn())).toBe(treeBefore)
  })
})

describe('what the pane shows', () => {
  test('hostile names from the server never reach the screen as escapes', async ($, on) => {
    const { clock, state } = world(on, { surfaces: ['terminal'] })
    state.playerName = '\u001b]0;pwned\u0007Eve'
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const ui = await mount($)
    expect(JSON.stringify(await ui.drawn())).not.toContain('\u001b')
    expect(JSON.stringify(await ui.drawn())).not.toContain('\u0007')
  })

  test('the terminal gets the game; every other surface gets a button that opens the browser', async ($, on) => {
    const { clock, opened } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    const terminal = await mount($, 'terminal')
    expect(await terminal.find({ key: 'bet' })).toBeDefined()
    await terminal.unmount()
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await mount($, surface)
      expect(await ui.find({ key: 'bet' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /opens in your browser/ })).toBeDefined()
      await ui.unmount()
    }
    const desktop = await mount($, 'desktop')
    await desktop.press({ key: 'web' })
    await clock.advance(50)
    expect(opened).toEqual([['open', `${BASE}/?c=abcDEF123xyz`]])
  })
})

describe('commands on a terminal', () => {
  test('/idlecrash opens the pane; /idlecrash web opens the browser', async ($, on) => {
    const { opened, paneOpens } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    const out = await run($)
    expect(paneOpens).toHaveLength(1)
    expect(opened).toHaveLength(0)
    expect(out.text).toMatch(/IdleCrash is open/)
    const web = await run($, 'web')
    expect(opened).toHaveLength(1)
    expect(web.text).toMatch(/opened in your browser/)
  })
})

describe('on the desktop app', () => {
  test('/idlecrash opens the browser, not a pane', async ($, on) => {
    const { opened, paneOpens } = world(on, { surfaces: ['desktop'] })
    await $.session.start(START)
    await run($)
    expect(opened).toHaveLength(1)
    expect(paneOpens).toHaveLength(0)
  })
})
