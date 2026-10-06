// What the mod says to the server and when: presence, the account, commands. The session here is a terminal.
import { describe, expect, test } from 'claude-code/testing'

import { PROTOCOL } from '../hooks/shared/protocol'
import { cleanBase, skewOf, skewText } from '../hooks/util'
import { BASE, DONE, PANE_PROPS, START, paths, run, world } from './world'

describe('a turn', () => {
  test('says "Claude is working" every two seconds, with this session\'s id, and stops when the turn ends', async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'build it', turnId: 't1' })
    await clock.advance(5000)
    const beats = calls.filter(c => c.path === '/presence' && c.body.working === true)
    expect(beats.length).toBeGreaterThanOrEqual(3)
    expect(beats.every(c => c.body.session === 'session-A')).toBe(true)

    await $.turn.complete(DONE)
    await clock.advance(50)
    const last = calls[calls.length - 1]!
    expect(last.path).toBe('/presence')
    expect(last.body).toEqual({ working: false, session: 'session-A' })
    const seen = calls.length
    await clock.advance(10_000)
    expect(calls.slice(seen).filter(c => c.path === '/presence')).toHaveLength(0) // no more beats after the turn
  })

  test('makes the account once and keeps its secret; later calls use it', async ($, on) => {
    const { clock, calls, state } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete(DONE)
    await clock.advance(50)
    await $.turn.start({ text: 'two', turnId: 't2' })
    await clock.advance(3000)
    expect(state.accounts).toBe(1)
    expect(calls.filter(c => c.path === '/presence').every(c => c.auth === 'Bearer acct1.secret1')).toBe(true)
  })

  test('a subagent finishing does not end it', async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete({ ...DONE, agentId: 'sub-1' })
    await clock.advance(3000)
    expect(calls.some(c => c.body.working === false)).toBe(false)
  })

  test('the finish says so in a toast, with the balance and what the turn was worth', async ($, on) => {
    const { clock, toasts } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete(DONE)
    await clock.advance(50)
    expect(toasts.some(t => /Claude finished, betting is locked\. Balance 1,000 \(\+0 this turn\)\./.test(t))).toBe(true)
  })
})

describe('a window with no pane of ours: an editor or a phone', () => {
  const plays = async ($: any, on: any, surface: string) => {
    const { clock, calls, paneOpens } = world(on, { surfaces: [surface] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(5000)
    await $.turn.complete(DONE)
    await clock.advance(50)
    expect(calls).toHaveLength(0) // nothing is asked of the server
    expect(paneOpens).toHaveLength(0)
    expect((await run($)).text).toMatch(/terminal or in the desktop app/) // and /idlecrash says why
  }

  test('an editor plays nothing', async ($, on) => plays($, on, 'vscode'))
  test('a phone plays nothing', async ($, on) => plays($, on, 'mobile'))
})

describe('/idlecrash off and on', () => {
  test('/idlecrash off stops the pane opening by itself, /idlecrash on brings it back', async ($, on) => {
    const { clock, paneOpens } = world(on)
    await $.session.start(START)
    await run($, 'off')
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    expect(paneOpens).toHaveLength(0)
    await $.turn.complete(DONE)
    await clock.advance(50)
    await run($, 'on')
    await $.turn.start({ text: 'y', turnId: 't2' })
    await clock.advance(1500)
    expect(paneOpens).toHaveLength(1)
  })
})

describe('trouble', () => {
  test('an unreachable server never throws; the pane says so', async ($, on) => {
    const { clock } = world(on, { down: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(8000)
    const ui = await $.ui.mount({ plugin: 'idlecrash', surface: 'terminal', component: 'Pane', requestId: 'idlecrash', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: `Cannot reach ${BASE}` })).toBeDefined()
    await $.turn.complete(DONE)
    await clock.advance(50)
  })
})

describe('a server and a mod of different ages', () => {
  test('every call carries the protocol the mod speaks', async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(5000)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(c => c.protocol === String(PROTOCOL))).toBe(true)
    await $.turn.complete(DONE)
    await clock.advance(50)
  })

  test('a server that no longer serves this mod: the pane says to update, and a toast says it once', async ($, on) => {
    const { clock, toasts } = world(on, { oldMod: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(8000)
    const ui = await $.ui.mount({ plugin: 'idlecrash', surface: 'terminal', component: 'Pane', requestId: 'idlecrash', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: skewText('mod-too-old', BASE) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `Cannot reach ${BASE}` })).toBeUndefined() // not "cannot reach": it did answer
    expect(toasts.filter(t => t === skewText('mod-too-old', BASE))).toHaveLength(1)
    await $.turn.complete(DONE)
    await clock.advance(50)
  })
})

describe('/idlecrash top', () => {
  test('prints the board with names cleaned of terminal escapes', async ($, on) => {
    world(on)
    await $.session.start(START)
    const out = await run($, 'top')
    expect(out.text).toContain('1. 31mEve  5,000')
    expect(out.text).not.toContain('\u001b')
  })
})

describe('a bad serverUrl', () => {
  test('makes no network calls and says what to fix', { options: { serverUrl: 'ftp://nope' } }, async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(6000)
    const out = await run($)
    expect(calls).toHaveLength(0)
    expect(out.text).toMatch(/serverUrl must look like/)
  })

  test('a good one is used as it is', { options: { serverUrl: 'https://crash.example.com/' } }, async ($, on) => {
    const { clock, calls } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('helpers', () => {
  test('a mod and a server that do not fit are told apart from a server that is just down', () => {
    expect(skewOf(426, { ok: false, error: 'mod-too-old', protocol: 5 })).toBe('mod-too-old')
    expect(skewOf(200, { ok: true, protocol: 1 }, 1)).toBeNull()
    expect(skewOf(200, { ok: true }, 0)).toBeNull() // a server from before the protocol is 0, and 0 is enough here
    expect(skewOf(200, { ok: true }, 1)).toBe('server-too-old')
    expect(skewOf(200, { ok: true, protocol: 1 }, 2)).toBe('server-too-old')
    expect(skewOf(409, { ok: false, error: 'closed', protocol: 2 }, 2)).toBeNull()
    // The proxy's error page while the server restarts, or no reply at all, says nothing about versions.
    expect(skewOf(502, null, 5)).toBeNull()
    expect(skewOf(502, 'Bad Gateway', 5)).toBeNull()
    expect(skewText('server-too-old', 'https://x.example')).toContain('https://x.example')
  })

  test('the server address is checked', () => {
    expect(cleanBase('https://crash.example.com/')).toBe('https://crash.example.com')
    expect(cleanBase('http://localhost:8787')).toBe('http://localhost:8787')
    expect(cleanBase('ftp://x')).toBeNull()
    expect(cleanBase('http://evil.com/path?x')).toBeNull()
    expect(cleanBase('javascript:alert(1)')).toBeNull()
    expect(cleanBase(undefined)).toBeNull()
  })
})
