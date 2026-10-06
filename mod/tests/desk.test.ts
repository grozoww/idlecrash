// The desktop app: the game lives in a pane of the mod, unless the `browser` setting asks for a browser. Its pictures are Svg in the plugin's tree;
// each button is a picture with the same picture lit over it on hover (the app does that) and a Client over both that
// catches the click: nothing in an Svg can be pressed, a button in the tree blinks at every redraw, and a native Button
// in a Client is drawn as plain text.
import { describe, expect, test } from 'claude-code/testing'

import { drawScene } from '../hooks/shared/scene'
import { buttonSvg, captionSvg, stageSvg, statusSvg, tableSvg } from '../hooks/desk-svg'
import { controlsOf } from '../hooks/desk'
import { picturePaths } from '../hooks/pixels'
import { DONE, PANE_PROPS, START, paths, run, world } from './world'

const mount = ($: any) =>
  $.ui.mount({ plugin: 'idlecrash', surface: 'desktop', component: 'Pane', requestId: 'idlecrash', props: PANE_PROPS })

const BTN = (id: string) => ({ in: `btn-${id}` })
const AMBER = '#ffc857'
/** Does one of the pictures say it? The status card that stands where the main button is not is a picture. */
const says = async (ui: any, words: string): Promise<boolean> => (await ui.findAll({ type: 'Svg' })).some((v: any) => String(v.props.source).includes(words))
const srcOf = async (ui: any, key: string): Promise<string[]> => ((await ui.find({ key }))!.children as { props: { source?: string } }[]).map(c => String(c.props?.source ?? ''))

/** A drawing as text, without the numbers the test kit gives each handler per mount. */
const plain = (tree: unknown): string => JSON.stringify(tree).replace(/"handle":\d+/g, '"handle":0')

/** A click as the app reports it: the pointer enters, goes down and comes up inside the button. */
async function click(ui: any, id: string): Promise<void> {
  await ui.resize({ columns: 30, rows: 2, ...BTN(id) })
  await ui.pointer({ type: 'enter', x: 2, y: 1, ...BTN(id) })
  await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', ...BTN(id) })
  await ui.pointer({ type: 'up', x: 2, y: 1, button: 'left', ...BTN(id) })
}

/** A turn that has begun and seated us at the table, with the pane drawn. */
async function seated($: any, on: any, opts: Parameters<typeof world>[1] = {}) {
  const w = world(on, { surfaces: ['desktop'], ...opts })
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await w.clock.advance(1500)
  return { ...w, ui: await mount($) }
}

describe('the desktop app', () => {
  test('/idlecrash opens the pane, and a turn seats you in it without a browser', async ($, on) => {
    const { clock, calls, opened, paneOpens } = world(on, { surfaces: ['desktop'] })
    await $.session.start(START)
    const out = await run($)
    expect(paneOpens).toHaveLength(1)
    expect(opened).toHaveLength(0)
    expect(out.text).toMatch(/IdleCrash is open/)

    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(1500)
    expect(paths(calls)).toContain('POST /join')
    expect(opened).toHaveLength(0) // the pane is the game here
    expect((await run($, 'web')).text).toMatch(/opened in your browser/) // the browser is still one word away
  })

  test('the pictures are Svg in the plugin tree and every button is a picture with a click Client over it', async ($, on) => {
    const { ui } = await seated($, on)
    const svgs = await ui.findAll({ type: 'Svg' })
    const stage = svgs[0]!
    expect(stage.props.width).toBeUndefined() // no fixed width: the pane shrinks it to fit, as the zoom changes
    const stageSource = String(stage.props.source)
    for (const shown of ['IDLECRASH', '● Claude is working', 'balance', '1,000', 'BETS OPEN']) expect(stageSource).toContain(shown)
    const tableSource = String(svgs.find(v => String(v.props.source).includes('LAST CRASHES'))!.props.source)
    for (const shown of ['TABLE T1 · 5 SEATED (1 BOTS)', 'me (you)', '⚙ Nova', 'LAST CRASHES', '2.10']) expect(tableSource).toContain(shown)

    for (const id of ['bet', 'stake1', 'stake2', 'stake3', 'stake4', 'auto', 'rebet']) {
      const wrap = (await ui.find({ key: `w-${id}` }))!
      expect(wrap.children).toHaveLength(3) // the picture, the same picture lit, and the click catcher
      const lit = wrap.children[1] as { props: { display: string }; hover: { display: string } }
      expect(lit.props.display).toBe('none') // hidden until the pointer is on the button...
      expect(lit.hover).toEqual({ display: 'flex' }) // ...when the app shows it, with no code of ours
      expect(await ui.find({ key: `btn-${id}` })).toBeDefined()
    }
    expect(await ui.find({ type: 'Button' })).toBeUndefined() // nothing in the plugin's tree can blink
  })

  test('the buttons bet and cash out', async ($, on) => {
    const { clock, calls, state, ui } = await seated($, on)
    await click(ui, 'bet')
    expect(paths(calls)).toContain('POST /bet')
    expect(state.bet?.amount).toBe(50)
    expect(await ui.find({ key: 'btn-bet' })).toBeUndefined() // the bet is placed: its button goes
    expect(await says(ui, 'bet placed: 50')).toBe(true)

    state.phase = 'running'
    state.phaseStart = clock.now() - 8000 - 3000
    await clock.advance(500)
    await click(ui, 'cash')
    expect(paths(calls)).toContain('POST /cashout')
    expect(await says(ui, 'cashed out 2.00x: paid 100')).toBe(true)
    expect(state.balance).toBe(1050)
  })

  test('the click catcher: a click is down and up on the button, a release outside is none', async ($, on) => {
    const { calls, ui } = await seated($, on)
    const at = (type: 'enter' | 'leave' | 'down' | 'up', x: number, y: number) => ({
      type,
      x,
      y,
      ...(type === 'down' || type === 'up' ? { button: 'left' as const } : {}),
      ...BTN('bet'),
    })
    await ui.resize({ columns: 30, rows: 2, ...BTN('bet') })
    await ui.pointer(at('up', 4, 1)) // up with no down before it
    await ui.pointer(at('down', 4, 1))
    await ui.pointer(at('up', 99, 1)) // let go outside: not a click
    await ui.pointer(at('down', 4, 1))
    await ui.pointer(at('leave', 4, 1)) // left the button while holding
    await ui.pointer(at('up', 4, 1))
    expect(paths(calls)).not.toContain('POST /bet')
    await ui.pointer(at('enter', 4, 1))
    await ui.pointer(at('down', 4, 1))
    await ui.pointer(at('up', 5, 1))
    expect(calls.filter(c => c.path === '/bet')).toHaveLength(1) // one press, not two
  })

  test('the controls keep their places: a bet changes what is in the main slot, not its height or the shares of a row', async ($, on) => {
    const { ui } = await seated($, on)
    const mainHeights = async () =>
      (await ui.findAll({ type: 'Svg' })).map(v => String(v.props.source)).filter(src => src.includes('viewBox="0 0 704 60"')).length
    expect(await mainHeights()).toBe(2) // the Bet button, at rest and lit
    expect(await ui.findAll({ type: 'Client' })).toHaveLength(7)

    await click(ui, 'bet')
    expect(await mainHeights()).toBe(1) // a card of the same height where the button was, with the line of text on it
    expect(await ui.findAll({ type: 'Client' })).toHaveLength(6)
    expect(String((await ui.findAll({ type: 'Svg' })).find(v => String(v.props.source).includes('bet placed'))!.props.source)).toContain('viewBox="0 0 704 60"')

    // The shares of a row add up to 100%, so every picture in the pane scales by the same factor.
    const share = async (key: string) => Number(String((await ui.find({ key }))!.props.width).replace('%', ''))
    expect((await share('w-stake1')) * 4 + 12).toBe(100)
    expect((await share('w-auto')) + (await share('w-rebet'))).toBe(100)
  })

  test('a press the table does not allow now is dropped before it reaches the server', async ($, on) => {
    const { calls, ui } = await seated($, on)
    await ui.post({ a: 'cash' }, BTN('bet')) // nothing riding
    expect(paths(calls)).not.toContain('POST /cashout')
    await ui.post({ a: 'bet' }, BTN('bet'))
    expect(calls.filter(c => c.path === '/bet')).toHaveLength(1)
    await ui.post({ a: 'bet' }, BTN('stake1')) // already bet: the bet button is gone, any button can still post
    await ui.post({ a: 'space' }, BTN('stake1')) // not a press
    expect(calls.filter(c => c.path === '/bet')).toHaveLength(1)
  })

  test('stake, auto cash-out and rebet are set from the buttons; nonsense is ignored', async ($, on) => {
    const { calls, ui } = await seated($, on)
    await ui.post({ a: 'stake', v: 7 }, BTN('stake1')) // not one of the stakes
    await ui.post({ a: 'stake', v: 'lots' }, BTN('stake1'))
    await click(ui, 'stake4')
    await click(ui, 'auto') // 2x, the default, to 3x
    await ui.post({ a: 'nonsense' }, BTN('auto'))
    await ui.post('not even an object' as never, BTN('auto'))
    await ui.post({ a: 'bet' }, BTN('bet'))
    expect(calls.find(c => c.path === '/bet')!.body).toEqual({ amount: 500, auto: 3 })
  })

  test('the picked stake and the options that are on say so', async ($, on) => {
    const { ui } = await seated($, on)
    const isAmber = async (id: string) => (await srcOf(ui, `w-${id}`))[0]!.includes(AMBER)
    expect(await isAmber('stake2')).toBe(true) // the default stake
    expect(await isAmber('stake3')).toBe(false)
    expect((await srcOf(ui, 'w-auto'))[0]).toContain('auto-out 2.00x')
    expect((await srcOf(ui, 'w-rebet'))[0]).toContain('rebet off')
    expect(await isAmber('auto')).toBe(true)
    expect(await isAmber('rebet')).toBe(false)

    await click(ui, 'stake3')
    await click(ui, 'rebet')
    await click(ui, 'auto')
    expect(await isAmber('stake3')).toBe(true)
    expect(await isAmber('stake2')).toBe(false)
    expect((await srcOf(ui, 'w-rebet'))[0]).toContain('rebet on')
    expect(await isAmber('rebet')).toBe(true)
    expect((await srcOf(ui, 'w-auto'))[0]).toContain('auto-out 3.00x')
  })

  test('nothing can be bet or set once Claude has finished: the buttons stay, dim, with nothing over them', async ($, on) => {
    const { clock, calls, ui } = await seated($, on)
    await $.turn.complete(DONE)
    await clock.advance(50)
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.some(v => String(v.props.source).includes('Betting is locked'))).toBe(true)
    expect(String(svgs[0]!.props.source)).toContain('Watching this round')
    expect(await ui.find({ key: 'w-bet' })).toBeUndefined() // no main button
    expect(await ui.findAll({ type: 'Client' })).toHaveLength(0) // nothing to click
    const stake = (await ui.find({ key: 'w-stake3' }))!
    expect(stake.children).toHaveLength(1) // just the dim picture: no lit one, no catcher, so the layout is the same
    expect(paths(calls)).not.toContain('POST /bet')
  })

  test('after Claude stops, an open bet can still be cashed out; nothing new can be bet', async ($, on) => {
    const { clock, calls, state, ui } = await seated($, on)
    await click(ui, 'bet')
    state.phase = 'running'
    state.phaseStart = clock.now() - 8000 - 3000
    await clock.advance(500)
    await $.turn.complete(DONE)
    await clock.advance(50)

    expect(String((await ui.findAll({ type: 'Svg' }))[0]!.props.source)).toContain('bet is still in') // the card wraps its words
    expect(await ui.find({ key: 'btn-cash' })).toBeDefined() // the main button is Cash out, on and lit like any other
    expect(await ui.find({ key: 'btn-stake3' })).toBeUndefined() // the stakes and options are off
    await ui.post({ a: 'stake', v: 100 }, BTN('cash')) // (a stake cannot be set now, but a cash-out can)
    await click(ui, 'cash')
    expect(paths(calls)).toContain('POST /cashout')
    expect(state.balance).toBe(1050)
    expect(await says(ui, 'cashed out 2.00x: paid 100')).toBe(true)
    expect(await ui.findAll({ type: 'Client' })).toHaveLength(0) // and with the bet taken there is nothing left to press
    expect(calls.filter(c => c.path === '/bet')).toHaveLength(1) // only the bet made while Claude was working
  })

  test('the plugin redraws the picture by itself and leaves the buttons alone', async ($, on) => {
    const { clock, state, invalidates, ui } = await seated($, on)
    const buttonsBefore = plain((await ui.find({ key: 'w-stake2' }))!.children)
    const pictureBefore = (await ui.find({ type: 'Svg' }))!.props.source
    const asked = invalidates.length
    await clock.advance(1000)
    expect(invalidates.length - asked).toBeGreaterThanOrEqual(7) // ten a second is the most the app takes

    await ui.unmount()
    const later = await mount($)
    expect((await later.find({ type: 'Svg' }))!.props.source).not.toBe(pictureBefore)
    expect(plain((await later.find({ key: 'w-stake2' }))!.children)).toBe(buttonsBefore) // the pictures only change when the table does

    // It stops when the round is over for good: no redraws for a pane nobody is playing in.
    await $.turn.complete(DONE)
    await clock.advance(200)
    state.roundOver = true
    await clock.advance(10_000)
    const quiet = invalidates.length
    await clock.advance(5000)
    expect(invalidates.length).toBe(quiet)
  })

  test('a terminal never starts the redraws: its picture moves on its own', async ($, on) => {
    const { clock, invalidates } = world(on, { surfaces: ['terminal'] })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(3000)
    expect(invalidates).toHaveLength(0)
  })

  test('hostile names from the server never reach the screen as escapes', async ($, on) => {
    const w = world(on, { surfaces: ['desktop'] })
    w.state.playerName = '\u001b]0;pwned\u0007Eve'
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await w.clock.advance(1500)
    const ui = await mount($)
    expect(JSON.stringify(await ui.drawn())).not.toContain('\u001b')
    expect(JSON.stringify(await ui.drawn())).not.toContain('\u0007')
  })

  test('a pane the app does not place waits for /idlecrash: no browser opens by itself on the desktop', async ($, on) => {
    const { clock, calls, opened, toasts } = world(on, { surfaces: ['desktop'], isPlaced: false })
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await clock.advance(5000)
    expect(paths(calls)).not.toContain('POST /join') // no seat for a pane nobody can see
    expect(opened).toHaveLength(0)
    expect(toasts.filter(t => /type \/idlecrash to open the game/.test(t))).toHaveLength(1) // said once
  })
})

describe('the desktop app with the browser asked for', () => {
  test('"system" keeps the browser: the pane there is a button that opens it', { options: { browser: 'system' } }, async ($, on) => {
    const { opened, paneOpens } = world(on, { surfaces: ['desktop'] })
    await $.session.start(START)
    await run($)
    expect(paneOpens).toHaveLength(0)
    expect(opened).toHaveLength(1)
    const ui = await mount($)
    expect(await ui.find({ key: 'w-bet' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /opens in your browser/ })).toBeDefined()
  })
})

describe('the pictures as vectors', () => {
  const head = { pill: { text: '● Claude is working', isOn: true }, balance: 1050, delta: 50 }

  test('a scene is one path per color', () => {
    // Two colors over four pixels by two: runs of one color merge along a row.
    expect(picturePaths(Uint8Array.from([1, 1, 2, 2, 1, 2, 2, 2]), 4, 2)).toBe(
      '<path fill="#9bdcff" d="M0 0h2v1h-2zM0 1h1v1h-1z"/><path fill="#72c4f7" d="M2 0h2v1h-2zM1 1h3v1h-3z"/>',
    )
  })

  test('the stage fits what the app takes of an Svg (131072 characters), whatever the round', () => {
    for (const phase of ['betting', 'running', 'crashed'] as const) {
      const input = { phase, multiplier: 12.5, runMs: 20_000, sinceCrashMs: 300, tMs: 1234, seed: 7 }
      const picture = picturePaths(drawScene(input, 56, 28), 56, 28)
      const svg = stageSvg({ head, picture, big: '12.50x', bigColor: '#fff', sub: 'your bet pays 625', watch: 'Claude finished: betting is locked. Watching this round.', message: null })
      expect(svg.length).toBeLessThan(131_072)
      expect(svg.startsWith('<svg ')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  test('with no round the stage says why, wrapped to fit its card', () => {
    const svg = stageSvg({ head, picture: null, big: '', bigColor: '', sub: '', watch: null, message: { title: 'Claude is idle', text: 'Betting is open only while Claude works. Send it a task and come back.' } })
    expect(svg).toContain('Claude is idle')
    expect(svg.match(/<text /g)!.length).toBeGreaterThanOrEqual(5) // the title, the balance, the name, the pill and the wrapped lines
  })

  test('a name or a message cannot break out of the markup', () => {
    const row = { name: '"><script>x</script>', bot: false, you: true, bet: 10, cash: null, payout: 0 }
    const svg = tableSvg({ id: 't1', seated: 1, bots: 0, players: [row], history: [2], phase: 'betting' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(stageSvg({ head, picture: null, big: '', bigColor: '', sub: '', watch: null, message: { title: '<b>&', text: '' } })).not.toContain('<b>')
  })

  test('the table grows with its players and wraps the last crashes', () => {
    const player = (name: string) => ({ name, bot: false, you: false, bet: 10, cash: null, payout: 0 })
    const small = tableSvg({ id: 't1', seated: 1, bots: 0, players: [player('a')], history: [2], phase: 'betting' })
    const big = tableSvg({ id: 't1', seated: 10, bots: 0, players: Array.from({ length: 10 }, (_, i) => player(`p${i}`)), history: Array.from({ length: 12 }, (_, i) => 1 + i / 4), phase: 'betting' })
    const heightOf = (svg: string): number => Number(/height="(\d+)" viewBox/.exec(svg)![1])
    expect(heightOf(big)).toBeGreaterThan(heightOf(small))
  })
})

describe('the buttons as pictures', () => {
  const controls = (over: Partial<Parameters<typeof controlsOf>[0]> = {}) =>
    controlsOf({ isLive: true, isWorking: true, phase: 'betting', mine: null, stake: 50, auto: 2, isRebet: false, notice: '', isNoticeError: false, ...over })!
  const bet = (c = controls()) => ('button' in c.main ? c.main.button : (undefined as never))

  test('a button at rest and lit differ, and are as big as the button says', () => {
    const b = bet()
    const rest = buttonSvg(b, 'rest')
    const hot = buttonSvg(b, 'hot')
    expect(rest).not.toBe(hot)
    for (const svg of [rest, hot]) expect(svg).toContain(`viewBox="0 0 ${b.units} ${b.height}"`)
    expect(rest).toContain('Bet 50')
  })

  test('a button that is off never lights, and the picked one is amber', () => {
    const off = controls({ isWorking: false }).stakes[0]!
    expect(buttonSvg(off, 'hot')).toBe(buttonSvg(off, 'rest'))
    const [ten, fifty] = controls().stakes
    expect(buttonSvg(fifty!, 'rest')).toContain('#ffc857')
    expect(buttonSvg(ten!, 'rest')).not.toContain('#ffc857')
  })

  test('a label cannot break out of the markup', () => {
    const b = { ...bet(), label: '"><script>x</script> & co' }
    expect(buttonSvg(b, 'rest')).not.toContain('<script>')
    expect(buttonSvg(b, 'rest')).toContain('&lt;script&gt;')
    expect(statusSvg('<b>', 'dim')).not.toContain('<b>')
    expect(captionSvg('stake')).toContain('stake')
  })

  test('the main slot is as tall as the status card that takes its place', () => {
    expect(buttonSvg(bet(), 'rest')).toContain('viewBox="0 0 704 60"')
    expect(statusSvg('bet placed: 50', 'warning')).toContain('viewBox="0 0 704 60"')
  })
})
