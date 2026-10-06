// The browser side: presence, opening the page, commands. The session here draws on the desktop app.
import { describe, expect, test } from 'claude-code/testing'

import { cleanBase } from '../hooks/util'
import { BASE, DONE, START, paths, run, world } from './world'

const LINK = `${BASE}/?c=abcDEF123xyz`

describe('a turn', () => {
  test('says "Claude is working" every two seconds, with this session\'s id, and stops when the turn ends', async ($, on) => {
    const { clock, calls } = world(on, { pageOpen: true })
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
    expect(calls.length).toBe(seen) // quiet after the turn
  })

  test('makes the account once and keeps its secret; later calls use it', async ($, on) => {
    const { clock, calls, state } = world(on, { pageOpen: true })
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
    const { clock, calls } = world(on, { pageOpen: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete({ ...DONE, agentId: 'sub-1' })
    await clock.advance(3000)
    expect(calls.some(c => c.body.working === false)).toBe(false)
  })

  test('the finish shows the balance and what happened to an open bet, on the status line and as a toast', async ($, on) => {
    const { clock, statuses, toasts } = world(on, { pageOpen: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    await $.turn.complete(DONE)
    await clock.advance(50)
    expect(toasts.some(t => /betting is locked/.test(t) && /cashed out for you \(\+120\)/.test(t))).toBe(true)
    expect(statuses.some(s => s?.includes('Balance 1,000'))).toBe(true)
    await clock.advance(21_000)
    expect(statuses[statuses.length - 1]).toBeUndefined() // the line clears itself
  })
})

describe('opening the page (no terminal: the desktop app)', () => {
  test('opens it once when it is not open, with a one-time code and never the secret', async ($, on) => {
    const { clock, calls, opened } = world(on, { pageOpen: false })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(10_000)
    expect(opened).toEqual([['open', LINK]])
    expect(JSON.stringify(opened)).not.toContain('secret1')
    expect(paths(calls).filter(p => p === 'POST /link')).toHaveLength(1)
  })

  test('does not open it again for half an hour', async ($, on) => {
    const w = world(on, { pageOpen: false })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await w.clock.advance(3000)
    await $.turn.complete(DONE)
    await w.clock.advance(50)
    await $.turn.start({ text: 'y', turnId: 't2' })
    await w.clock.advance(5000)
    expect(w.opened).toHaveLength(1)
  })

  test('with the page already open it opens nothing', async ($, on) => {
    const { clock, opened } = world(on, { pageOpen: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(10_000)
    expect(opened).toHaveLength(0)
  })

  test('/idlecrash off stops it opening by itself, /idlecrash on brings it back', async ($, on) => {
    const { clock, opened } = world(on, { pageOpen: false })
    await $.session.start(START)
    await run($, 'off')
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(6000)
    expect(opened).toHaveLength(0)
    await $.turn.complete(DONE)
    await clock.advance(50)
    await run($, 'on')
    await $.turn.start({ text: 'y', turnId: 't2' })
    await clock.advance(6000)
    expect(opened).toHaveLength(1)
  })

  test('/idlecrash opens the page now, even when Claude is idle', async ($, on) => {
    const { opened } = world(on)
    await $.session.start(START)
    const out = await run($)
    expect(opened).toEqual([['open', LINK]])
    expect(out.text).toMatch(/opened in your browser/)
  })

  test('/idlecrash link prints the address and opens nothing', async ($, on) => {
    const { opened } = world(on)
    await $.session.start(START)
    const out = await run($, 'link')
    expect(out.text).toContain(LINK)
    expect(opened).toHaveLength(0)
  })

  test('when no program can open it, the address is shown instead', async ($, on) => {
    const { opened } = world(on, { exitCode: 127 })
    await $.session.start(START)
    const out = await run($)
    expect(out.text).toContain(LINK)
    expect(opened.map(argv => argv[0])).toEqual(['open', 'xdg-open', 'cmd']) // it tried each in turn
  })

  test('a code that is not a plain token is never put in an address or run', async ($, on) => {
    const { state, opened } = world(on)
    state.code = 'x; rm -rf ~'
    await $.session.start(START)
    const out = await run($)
    expect(opened).toHaveLength(0)
    expect(out.text).toMatch(/no link/)
  })
})

describe('the app\'s browser panel', () => {
  test('is used when the session has one, and the system browser is left alone', async ($, on) => {
    const { opened, appOpens } = world(on, { appBrowser: true })
    await $.session.start(START)
    const out = await run($)
    expect(appOpens).toEqual([`mcp__Claude_Browser__preview_start ${LINK}`])
    expect(opened).toHaveLength(0)
    expect(out.text).toMatch(/app's browser panel/)
  })

  test('auto-opens there when Claude starts working in the desktop app', async ($, on) => {
    const { clock, opened, appOpens } = world(on, { appBrowser: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(6000)
    expect(appOpens).toHaveLength(1)
    expect(opened).toHaveLength(0)
  })

  test('if the panel refuses (permission, no such tool), the default browser takes over', async ($, on) => {
    const { opened, appOpens } = world(on, { appBrowser: true, appBrowserFails: true })
    await $.session.start(START)
    const out = await run($)
    expect(appOpens).toHaveLength(1)
    expect(opened).toEqual([['open', LINK]])
    expect(out.text).toMatch(/your browser/)
  })

  test('without the tool it goes straight to the default browser', async ($, on) => {
    const { opened, appOpens } = world(on)
    await $.session.start(START)
    await run($)
    expect(appOpens).toHaveLength(0)
    expect(opened).toEqual([['open', LINK]])
  })

  test('"system" never touches the panel', { options: { browser: 'system' } }, async ($, on) => {
    const { opened, appOpens } = world(on, { appBrowser: true })
    await $.session.start(START)
    await run($)
    expect(appOpens).toHaveLength(0)
    expect(opened).toEqual([['open', LINK]])
  })

  test('"app" never falls back: it shows the address instead', { options: { browser: 'app' } }, async ($, on) => {
    const { opened } = world(on, { appBrowser: true, appBrowserFails: true })
    await $.session.start(START)
    const out = await run($)
    expect(opened).toHaveLength(0)
    expect(out.text).toContain(LINK)
  })
})

describe('trouble', () => {
  test('an unreachable server never throws; the status line says so', async ($, on) => {
    const { clock, statuses } = world(on, { down: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(8000)
    expect(statuses.some(s => s?.includes(`cannot reach ${BASE}`))).toBe(true)
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
    const { clock, calls, opened } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(6000)
    const out = await run($)
    expect(calls).toHaveLength(0)
    expect(opened).toHaveLength(0)
    expect(out.text).toMatch(/serverUrl must look like/)
  })

  test('a good one is used as it is', { options: { serverUrl: 'https://crash.example.com/' } }, async ($, on) => {
    const { clock, calls } = world(on, { pageOpen: true })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('helpers', () => {
  test('the server address is checked', () => {
    expect(cleanBase('https://crash.example.com/')).toBe('https://crash.example.com')
    expect(cleanBase('http://localhost:8787')).toBe('http://localhost:8787')
    expect(cleanBase('ftp://x')).toBeNull()
    expect(cleanBase('http://evil.com/path?x')).toBeNull()
    expect(cleanBase('javascript:alert(1)')).toBeNull()
    expect(cleanBase(undefined)).toBeNull()
  })
})
