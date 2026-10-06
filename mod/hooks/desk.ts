// The desktop pane, as data. Its pictures (the stage and the table, see desk-svg.ts) are drawn by the plugin,
// redrawn many times a second; the Client is the buttons, and gets `DeskControls`. Those change only when the
// table or the player's picks do, so the buttons are not redrawn under the pointer.
// The Client posts the player's presses back (see `DeskPress`); it never reaches the plugin's `$`.
import type { Local, Phase, Snapshot, Status } from '../types'
import type { Head, Table } from './desk-svg'
import { STAKES, fmt, payoutFor, seconds, times } from './shared/lib'
import type { SceneProps } from './shared/scene'

/** The picture is drawn at this size whatever the pane's width: the app scales it. The terminal draws it this size too. */
export const PICTURE = { width: 56, height: 28 } as const

/** The picture's inputs. */
export type DeskScene = Omit<SceneProps, 'columns' | 'rows'>

export type DeskControls = {
  /** The table is on: show the buttons. */
  isLive: boolean
  isWorking: boolean
  phase: Phase
  mine: Snapshot['you']['bet']
  stake: number
  auto: number | null
  isRebet: boolean
  notice: string
  isNoticeError: boolean
}

/** The one line under the terminal's picture: the countdown, the multiplier with what a cash-out pays, or the crash. */
export function pictureLine(scene: DeskScene, multiplier: number, serverNow: number): { text: string; color: 'warning' | 'success' | 'error' } {
  if (scene.phase === 'betting') return { text: `BETS OPEN  ${seconds(scene.bettingEndsAt - serverNow)}s`, color: 'warning' }
  if (scene.phase === 'running') {
    const pays = scene.stake > 0 ? `   cash out now: ${fmt(payoutFor(scene.stake, multiplier))}` : ''
    return { text: `▲ ${times(multiplier)}${pays}`, color: 'success' }
  }
  return { text: `✖ CRASHED at ${times(multiplier)}`, color: 'error' }
}

/** What the Client posts. The plugin checks every field: this is input from code, not a fact. */
export type DeskPress = { a: 'bet' | 'cash' | 'auto' | 'rebet' } | { a: 'stake'; v: number }

/** One button of the desktop pane: what it says, how it looks, and what it posts. */
export type ButtonSpec = {
  id: string
  label: string
  kind: 'bet' | 'cash' | 'plain'
  /** A stake that is picked, an option that is on. */
  isOn: boolean
  /** Claude is not working: drawn dim, with nothing over it to press. */
  isDisabled: boolean
  press: DeskPress
  /** Its share of the row, as the pane's layout wants it: the shares of a row add up to 100%. */
  share: string
  /** Its width in the picture's own units. A row is `ROW_UNITS` wide, so every picture scales by the same factor. */
  units: number
  /** Its height in the same units. */
  height: number
}

export const ROW_UNITS = 704
const MAIN_HEIGHT = 60
const CHIP_HEIGHT = 52

const unitsOf = (percent: number): number => Math.round((ROW_UNITS * percent) / 100)

const button = (id: string, label: string, kind: ButtonSpec['kind'], isOn: boolean, isDisabled: boolean, press: DeskPress, percent: number, height: number): ButtonSpec => ({
  id,
  label,
  kind,
  isOn,
  isDisabled,
  press,
  share: `${percent}%`,
  units: unitsOf(percent),
  height,
})

/** The word in front of the stakes: a picture of its own, so that the row keeps its shares when the pane shrinks. */
export const CAPTION = { share: '12%', units: unitsOf(12), height: CHIP_HEIGHT }

/**
 * What the player can press, always in the same places: the main slot (a button, or a card of the same height when
 * there is nothing to press), then the stakes and the two options. When Claude is not working they stay, dim, so the
 * pane does not jump when a turn starts or ends.
 */
export type Controls = {
  main: { button: ButtonSpec } | { text: string; color: 'warning' | 'success' | 'dim' }
  stakes: ButtonSpec[]
  options: ButtonSpec[]
}

export function controlsOf(c: DeskControls): Controls | null {
  if (!c.isLive) return null
  const off = !c.isWorking
  const isLive = !!c.mine && c.mine.cash === null && c.phase !== 'crashed'
  let main: Controls['main']
  // An open bet can be cashed out while the plane flies, whether Claude is still working or not.
  if (isLive && c.phase === 'running') main = { button: button('cash', 'Cash out', 'cash', false, false, { a: 'cash' }, 100, MAIN_HEIGHT) }
  else if (!off && c.phase === 'betting' && !c.mine) main = { button: button('bet', `Bet ${fmt(c.stake)}`, 'bet', false, false, { a: 'bet' }, 100, MAIN_HEIGHT) }
  else main = statusOf(c) ?? { text: ' ', color: 'dim' }
  return {
    main,
    stakes: STAKES.map((s, i) => button(`stake${i + 1}`, fmt(s), 'plain', c.stake === s, off, { a: 'stake', v: s }, 22, CHIP_HEIGHT)),
    options: [
      button('auto', `auto-out ${c.auto ? times(c.auto) : 'off'}`, 'plain', c.auto !== null, off, { a: 'auto' }, 55, CHIP_HEIGHT),
      button('rebet', `rebet ${c.isRebet ? 'on' : 'off'}`, 'plain', c.isRebet, off, { a: 'rebet' }, 45, CHIP_HEIGHT),
    ],
  }
}

/** The line that stands where the main button is not: what happened to the bet, or why there is none. */
export function statusOf(c: DeskControls): { text: string; color: 'warning' | 'success' | 'dim' } | null {
  if (!c.isLive) return null
  const { mine, phase } = c
  if (mine && mine.cash !== null) return { text: `cashed out ${times(mine.cash)}: paid ${fmt(mine.payout)}`, color: 'success' }
  if (!c.isWorking) {
    return mine
      ? { text: 'Betting is locked. Your bet is still in.', color: 'warning' }
      : { text: 'Betting is locked until Claude works again.', color: 'dim' }
  }
  if (phase === 'betting' && !mine) return null
  if (mine && phase === 'running') return null
  if (mine && phase === 'betting') return { text: `bet placed: ${fmt(mine.amount)}${mine.auto ? ` · auto ${times(mine.auto)}` : ''}`, color: 'warning' }
  return { text: 'next round soon', color: 'dim' }
}

export type DeskView = {
  controls: DeskControls
  head: Head
  scene: DeskScene | null
  /** Instead of the scene: what to wait for, or what went wrong. */
  message: { title: string; text: string } | null
  /** Claude has stopped and the round is being watched out. */
  watch: string | null
  table: Table | null
}

const OFF: DeskControls = {
  isLive: false,
  isWorking: false,
  phase: 'betting',
  mine: null,
  stake: 0,
  auto: null,
  isRebet: false,
  notice: '',
  isNoticeError: false,
}

/** The same cases as the web page and the terminal's pane, as data. `serverNow` is our estimate of the server's clock. */
export function deskView(snap: Snapshot | null, wish: Local, st: Status, serverNow: number): DeskView {
  const head: Head = {
    pill: st.isWorking ? { text: '● Claude is working', isOn: true } : { text: 'Claude is idle', isOn: false },
    balance: snap ? snap.you.balance : null,
    delta: snap && st.balanceAtStart !== null ? snap.you.balance - st.balanceAtStart : null,
  }
  const quiet = (message: DeskView['message']): DeskView => ({ controls: OFF, head, scene: null, message, watch: null, table: null })

  if (!st.isWorking && !st.isWatching && st.summary) return quiet({ title: 'Betting is locked', text: st.summary })
  if (!st.isWorking && !st.isWatching) {
    return quiet({ title: 'Claude is idle', text: 'Betting is open only while Claude works. Send it a task and come back.' })
  }
  if (!snap || !st.isJoined) {
    return quiet(st.error ? { title: st.error, text: 'Trying to reach the server.' } : { title: 'Taking a seat…', text: '' })
  }

  const phase = snap.table.phase
  const mine = snap.you.bet
  const isLive = !!mine && mine.cash === null && phase !== 'crashed'
  return {
    controls: {
      isLive: true,
      isWorking: st.isWorking,
      phase,
      mine,
      stake: wish.stake,
      auto: wish.auto,
      isRebet: wish.isRebet,
      notice: st.error ?? st.note ?? (st.isWorking ? '' : (st.summary ?? '')),
      isNoticeError: !!st.error,
    },
    head,
    scene: {
      phase,
      round: snap.table.round,
      growth: snap.growth,
      runStartedAt: snap.table.runStartedAt,
      crashedAt: snap.table.crashedAt,
      crashPoint: snap.table.crashPoint,
      bettingEndsAt: snap.table.bettingEndsAt,
      serverNow,
      stake: isLive && phase === 'running' ? mine!.amount : 0,
    },
    message: null,
    watch: st.isWorking
      ? null
      : isLive
        ? 'Claude finished: betting is locked. Your bet is still in: cash out before the crash.'
        : 'Claude finished: betting is locked. Watching this round.',
    table: {
      id: snap.table.id,
      seated: snap.table.humans + snap.table.bots,
      bots: snap.table.bots,
      players: snap.players,
      history: snap.history,
      phase,
    },
  }
}
