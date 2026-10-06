// The desktop pane's pictures, as SVG in the web page's colors: the stage (header, scene, the big number)
// and the table (players, last crashes). Each is drawn on a dark card of its own, so it reads the same in a
// light app and in a dark one. They are not pressable (nothing in an Svg is), so the buttons are a Client.
import type { Phase, Row } from '../types'
import { fmt, payoutFor, seconds, sign, times } from './shared/lib'
import { CAPTION, PICTURE, ROW_UNITS } from './desk'
import type { ButtonSpec, DeskScene } from './desk'

const COLOR = {
  bg: '#12141b',
  panel: '#1b1f2c',
  panel2: '#232839',
  line: '#2d3550',
  ink: '#eceff8',
  dim: '#8a93ab',
  green: '#5fe0a0',
  red: '#ff6f61',
  amber: '#ffc857',
} as const

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
/** One scene pixel is this many SVG units. The app scales the whole card to its pane. */
const SCALE = 12
/** Both cards are this wide, so they line up. */
export const WIDTH = 704
const HEAD = 46 // the header's height above the stage
const CHAR = 0.6 // a monospace character's width, in ems

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const text = (x: number, y: number, size: number, fill: string, content: string, extra = ''): string =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}"${extra ? ` ${extra}` : ''}>${esc(content)}</text>`

/** Words onto lines of at most `max` characters; a longer word keeps its own line. */
export function wrap(words: string, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of words.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

// ---- the stage ---------------------------------------------------------------------

/** The big number over the picture and the line under it, as the web page shows them. */
export function overlayOf(scene: DeskScene, multiplier: number, now: number): { big: string; color: string; sub: string } {
  if (scene.phase === 'betting') return { big: `${seconds(scene.bettingEndsAt - now)}s`, color: COLOR.amber, sub: 'BETS OPEN' }
  if (scene.phase === 'running') {
    const sub = scene.stake > 0 ? `your bet pays ${fmt(payoutFor(scene.stake, multiplier))}` : ''
    return { big: times(multiplier), color: multiplier >= 2 ? COLOR.green : '#fff', sub }
  }
  return { big: times(scene.crashPoint ?? multiplier), color: COLOR.red, sub: 'CRASHED' }
}

export type Head = {
  pill: { text: string; isOn: boolean }
  balance: number | null
  delta: number | null
}

export type Stage = {
  head: Head
  /** The scene's paths (`picturePaths`), or none while there is no round to show. */
  picture: string | null
  big: string
  bigColor: string
  sub: string
  /** Claude has stopped and the round is being watched out. */
  watch: string | null
  /** Instead of the picture: what to wait for, or what went wrong. */
  message: { title: string; text: string } | null
}

function header(head: Head): string {
  const pillW = Math.round(head.pill.text.length * 13 * CHAR + 20)
  let out = text(14, 30, 20, COLOR.ink, 'IDLECRASH', 'font-weight="700" letter-spacing="2.8"')
  out += `<rect x="161" y="14" width="${pillW}" height="22" rx="11" fill="${COLOR.panel2}"/>`
  out += text(171, 29, 13, head.pill.isOn ? COLOR.green : COLOR.amber, head.pill.text)
  const delta =
    head.balance !== null && head.delta !== null
      ? `<tspan font-size="13" dx="8" fill="${head.delta >= 0 ? COLOR.green : COLOR.red}">${esc(sign(head.delta))} this turn</tspan>`
      : ''
  out += `<text x="${WIDTH - 14}" y="30" text-anchor="end" font-family="${FONT}" font-size="16" fill="${COLOR.ink}">balance <tspan font-weight="700">${head.balance === null ? '–' : esc(fmt(head.balance))}</tspan>${delta}</text>`
  return out
}

export function stageSvg(stage: Stage): string {
  const pictureW = PICTURE.width * SCALE
  const pictureH = PICTURE.height * SCALE
  const panelH = stage.picture !== null ? pictureH + 16 : 150
  const height = HEAD + panelH + 4
  let body = `<rect width="${WIDTH}" height="${height}" rx="8" fill="${COLOR.bg}"/>${header(stage.head)}`
  body += `<rect x="1" y="${HEAD}" width="${WIDTH - 2}" height="${panelH}" rx="6" fill="${COLOR.panel}" stroke="${COLOR.line}" stroke-width="2"/>`

  if (stage.picture !== null) {
    const x = (WIDTH - pictureW) / 2
    body += `<g transform="translate(${x} ${HEAD + 8}) scale(${SCALE})" shape-rendering="crispEdges">${stage.picture}</g>`
    // The number has a dark outline instead of the page's text shadow, so it reads on sky and on grass.
    const outline = (w: number): string => `stroke="#000" stroke-opacity=".55" stroke-width="${w}" stroke-linejoin="round" paint-order="stroke"`
    body += text(x + 14, HEAD + 62, 44, stage.bigColor, stage.big, `font-weight="800" ${outline(6)}`)
    if (stage.sub) body += text(x + 14, HEAD + 86, 14, '#fff', stage.sub, outline(4))
    if (stage.watch) {
      const lines = wrap(stage.watch, 40)
      const w = Math.round(Math.max(...lines.map(l => l.length)) * 12 * CHAR + 20)
      const left = x + pictureW - 14 - w
      body += `<rect x="${left}" y="${HEAD + 16}" width="${w}" height="${lines.length * 16 + 10}" rx="4" fill="#0e1018" fill-opacity=".8" stroke="${COLOR.line}"/>`
      lines.forEach((line, i) => {
        body += text(left + 10, HEAD + 34 + i * 16, 12, COLOR.amber, line)
      })
    }
  } else if (stage.message) {
    body += text(WIDTH / 2, HEAD + 62, 20, COLOR.ink, stage.message.title, 'font-weight="700" text-anchor="middle"')
    wrap(stage.message.text, 72)
      .slice(0, 3)
      .forEach((line, i) => {
        body += text(WIDTH / 2, HEAD + 94 + i * 22, 16, COLOR.dim, line, 'text-anchor="middle"')
      })
  }
  return svg(WIDTH, height, body)
}

// ---- the table ---------------------------------------------------------------------

export type Table = {
  id: string
  seated: number
  bots: number
  players: Row[]
  history: number[]
  phase: Phase
}

const ROW = 28
const GAP = 10 // between the two cards
const SIZE = 16 // the text of both cards

/** The players, then the last crashes under them: the pane has more room down than across. */
export function tableSvg(table: Table): string {
  const title = (label: string): string => text(14, 30, 13, COLOR.dim, label.toUpperCase(), 'letter-spacing="1.6"')

  let players = title(`table ${table.id} · ${table.seated} seated${table.bots ? ` (${table.bots} bots)` : ''}`)
  table.players.forEach((p, i) => {
    const y = 64 + i * ROW
    players += text(14, y, SIZE, COLOR.ink, `${p.bot ? '⚙ ' : ''}${p.name}${p.you ? ' (you)' : ''}`, p.you ? 'font-weight="700"' : '')
    players += text(360, y, SIZE, COLOR.ink, p.bet > 0 ? fmt(p.bet) : '–', 'text-anchor="end"')
    if (p.bet > 0 && p.cash !== null) players += text(384, y, SIZE, COLOR.green, `${times(p.cash)} → ${fmt(p.payout)}`)
    else if (p.bet > 0 && table.phase === 'crashed') players += text(384, y, SIZE, COLOR.red, 'lost')
    else if (p.bet > 0) players += text(384, y, SIZE, COLOR.dim, table.phase === 'betting' ? 'in' : '…')
  })
  const playersH = 64 + (Math.max(1, table.players.length) - 1) * ROW + 20

  // The last crashes wrap like the page's chips do.
  const chipH = 28
  let chips = ''
  let x = 14
  let y = 46
  for (const point of table.history) {
    const label = point.toFixed(2)
    const w = Math.round(label.length * SIZE * CHAR + 20)
    if (x + w > WIDTH - 14 && x > 14) {
      x = 14
      y += chipH + 8
    }
    chips += `<rect x="${x}" y="${y}" width="${w}" height="${chipH}" rx="5" fill="${COLOR.panel2}"/>`
    chips += text(x + 10, y + 20, SIZE, point >= 2 ? COLOR.green : COLOR.red, label)
    x += w + 8
  }
  const historyH = table.history.length > 0 ? y + chipH + 18 : 60

  const card = (at: number, height: number, inner: string): string =>
    `<g transform="translate(0 ${at})"><rect x="1" y="1" width="${WIDTH - 2}" height="${height - 2}" rx="6" fill="${COLOR.panel}" stroke="${COLOR.line}" stroke-width="2"/>${inner}</g>`
  const body = card(0, playersH, players) + card(playersH + GAP, historyH, title('last crashes') + chips)
  return svg(WIDTH, playersH + GAP + historyH, body)
}

// ---- the buttons ----------------------------------------------------------------------

const BLUE = '#6cb8ff'
const LOOK = {
  bet: { fill: '#2d6a4f', hot: '#37805f', line: '#3f9b73', hotLine: '#5fe0a0', ink: '#eceff8' },
  cash: { fill: '#8a5a12', hot: '#a06b18', line: '#d99a2b', hotLine: COLOR.amber, ink: '#fff3d6' },
  plain: { fill: COLOR.panel2, hot: '#2b3248', line: COLOR.line, hotLine: BLUE, ink: COLOR.ink },
} as const

/**
 * A button as a picture, at rest or lit. The pane shows the lit one over the other while the pointer is on the
 * button (see the Box with `hover` in register.tsx), so the change takes no code of ours and no round trip.
 * Nothing in an Svg can be pressed: a Client over the picture catches the click.
 */
export function buttonSvg(b: ButtonSpec, view: 'rest' | 'hot'): string {
  const look = LOOK[b.kind]
  const isLit = view === 'hot' && !b.isDisabled
  const fill = b.isDisabled ? COLOR.panel : isLit ? look.hot : look.fill
  const line = b.isDisabled ? COLOR.line : b.isOn ? COLOR.amber : isLit ? look.hotLine : look.line
  const ink = b.isDisabled ? COLOR.dim : b.isOn ? COLOR.amber : look.ink
  const size = b.kind === 'plain' ? 20 : 24
  const body =
    `<rect x="3" y="3" width="${b.units - 6}" height="${b.height - 6}" rx="9" fill="${fill}" stroke="${line}" stroke-width="3"/>` +
    text(b.units / 2, b.height / 2 + size * 0.34, size, ink, b.label, `text-anchor="middle"${b.kind === 'plain' ? '' : ' font-weight="700"'}`)
  return svg(b.units, b.height, body)
}

/** The main slot when there is nothing to press: a card as tall as the button, so nothing below it moves. */
export function statusSvg(message: string, color: 'warning' | 'success' | 'dim'): string {
  const ink = color === 'warning' ? COLOR.amber : color === 'success' ? COLOR.green : COLOR.dim
  const body =
    `<rect x="3" y="3" width="${ROW_UNITS - 6}" height="54" rx="9" fill="${COLOR.panel}" stroke="${COLOR.line}" stroke-width="3"/>` +
    text(ROW_UNITS / 2, 36, 18, ink, message, 'text-anchor="middle"')
  return svg(ROW_UNITS, 60, body)
}

/** The word in front of the stakes. */
export function captionSvg(label: string): string {
  return svg(CAPTION.units, CAPTION.height, text(4, CAPTION.height / 2 + 6, 16, COLOR.dim, label))
}
