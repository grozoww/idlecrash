// GENERATED from /shared by tools/sync-shared.ts. Edit the original, not this copy.
// The pixel-art picture in the IdleCrash pane: a plane takes off from a runway,
// climbs past houses, mountains and clouds, and falls when the round crashes.
//
// Pure functions. A frame depends only on its input, so the same input draws
// the same picture. `drawScene` returns palette indices, one byte per pixel;
// pixels.ts turns them into terminal cells or an SVG.

import { multiplierAt } from './lib'

export type ScenePhase = 'betting' | 'running' | 'crashed'

export type SceneInput = {
  phase: ScenePhase
  /** The live multiplier while flying, the crash point once crashed. */
  multiplier: number
  /** Milliseconds since the flight began (frozen at the crash). */
  runMs: number
  /** Milliseconds since the crash; 0 before it. */
  sinceCrashMs: number
  /** An animation clock: propeller, drifting clouds, smoke. */
  tMs: number
  /** The round, so every round has other scenery. */
  seed: number
}

/** What the scene needs to know about the round, as plain data. */
export type SceneProps = {
  phase: ScenePhase
  round: number
  /** Width in terminal columns, which is also the picture's width in pixels. */
  columns: number
  /** Terminal rows of picture: the scene is twice as many pixels tall. */
  rows: number
  growth: number
  runStartedAt: number | null
  crashedAt: number | null
  crashPoint: number | null
  bettingEndsAt: number
  /** Our estimate of the server's clock at the moment these props were made, in ms. */
  serverNow: number
  /** What the player has riding on this round, 0 for nothing. */
  stake: number
}

/**
 * The scene's input `elapsedMs` after the props were made. Time comes from the
 * props plus what has passed since, never from a wall clock the two sides might
 * not share.
 */
export function sceneInputFor(
  props: SceneProps,
  elapsedMs: number,
): { input: SceneInput; multiplier: number; serverNow: number } {
  const serverNow = props.serverNow + Math.max(0, elapsedMs)
  const started = props.runStartedAt ?? serverNow
  const runMs = props.phase === 'crashed' ? (props.crashedAt ?? serverNow) - started : serverNow - started
  const multiplier =
    props.phase === 'crashed' ? (props.crashPoint ?? 1) : props.phase === 'running' ? multiplierAt(runMs, props.growth) : 1
  return {
    serverNow,
    multiplier,
    input: {
      phase: props.phase,
      multiplier,
      runMs: Math.max(0, runMs),
      sinceCrashMs: props.phase === 'crashed' ? Math.max(0, serverNow - (props.crashedAt ?? serverNow)) : 0,
      tMs: serverNow % 10_000_000,
      seed: props.round,
    },
  }
}

// ---- palette -----------------------------------------------------------------

const DEFS = [
  ['clear', '#000000'],
  ['sky0', '#9bdcff'], ['sky1', '#72c4f7'], ['sky2', '#4aa6e6'], ['sky3', '#3182cf'],
  ['sky4', '#2255a4'], ['sky5', '#17336f'], ['sky6', '#0c1a42'],
  ['star', '#dfe8ff'], ['sun', '#fff0a0'],
  ['cloud', '#ffffff'], ['cloudShade', '#c9d8ee'],
  ['far', '#7a8fb8'], ['farShade', '#5f739c'], ['near', '#52745f'], ['nearShade', '#3d5a4a'],
  ['snow', '#f4f8ff'], ['snowShade', '#c4d2ea'],
  ['grass', '#58b84c'], ['grassDark', '#3d8f3a'], ['dirt', '#7a5230'],
  ['runway', '#4b4b55'], ['runwayLine', '#eeeeee'],
  ['wallCream', '#ecd9a9'], ['wallWhite', '#f1f1ea'], ['wallPeach', '#efc29b'], ['wallShade', '#bfa877'],
  ['roofRed', '#c8402f'], ['roofBlue', '#3f6db3'], ['roofBrown', '#8a5a3b'], ['roofDark', '#7d2a20'],
  ['window', '#5ec8ff'], ['door', '#6b3e1f'],
  ['leaf', '#2f8a38'], ['leafDark', '#226a2a'], ['trunk', '#6b3e1f'],
  ['body', '#f3ead2'], ['bodyShade', '#c9bd9d'], ['accent', '#c8402f'], ['glass', '#5ec8ff'],
  ['wing', '#e4dcc4'], ['wingShade', '#a99f84'], ['strut', '#5b6070'],
  ['cowl', '#8e97a8'], ['cowlHi', '#d3dae6'], ['nose', '#ffd54a'],
  ['prop', '#2f333c'], ['propBlur', '#8a93a3'], ['wheel', '#23232a'], ['hub', '#aeb6c4'],
  ['fireY', '#ffe14d'], ['fireO', '#ff9a1f'], ['fireR', '#e8401c'],
  ['smoke0', '#3a3a42'], ['smoke1', '#62626d'], ['smoke2', '#92929e'], ['smoke3', '#b9b9c4'],
] as const

export type ColorName = (typeof DEFS)[number][0]

const INDEX = {} as Record<ColorName, number>
DEFS.forEach(([name], i) => {
  INDEX[name] = i
})

export const PALETTE: string[] = DEFS.map(([, hex]) => hex)
export const colorIndex = (name: ColorName): number => INDEX[name]

const SKY: ColorName[] = ['sky0', 'sky1', 'sky2', 'sky3', 'sky4', 'sky5', 'sky6']

// ---- small helpers ------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** A triangle wave in 0..1, peaking at 0.5 of each period. */
const tri = (p: number): number => 1 - Math.abs(2 * (p - Math.floor(p)) - 1)

/** A repeatable pseudo-random number in 0..1 from two integers. */
function hash(a: number, b: number): number {
  let x = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35)
  x ^= x >>> 15
  x = Math.imul(x, 0x2c1b3c6d)
  x ^= x >>> 12
  return (x >>> 0) / 4294967296
}

class Canvas {
  readonly px: Uint8Array

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.px = new Uint8Array(width * height)
  }

  set(x: number, y: number, name: ColorName): void {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.px[y * this.width + x] = INDEX[name]
  }

  rect(x: number, y: number, w: number, h: number, name: ColorName): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, name)
  }

  disc(cx: number, cy: number, r: number, name: ColorName): void {
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + r * 0.5) this.set(cx + i, cy + j, name)
    }
  }
}

// ---- sprites -----------------------------------------------------------------

type Sprite = { rows: string[]; colors: Record<string, ColorName> }

function stamp(c: Canvas, sprite: Sprite, x: number, y: number): void {
  sprite.rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const name = sprite.colors[row[i]!]
      if (name) c.set(x + i, y + j, name)
    }
  })
}

const ROOFS: ColorName[] = ['roofRed', 'roofBlue', 'roofBrown']
const WALLS: ColorName[] = ['wallCream', 'wallWhite', 'wallPeach']

const houseSprite = (roof: ColorName, wall: ColorName): Sprite => ({
  rows: ['..RRR..', '.RRRRr.', 'RRRRRrr', '.WWWWw.', '.WoWow.', '.WWWDw.'],
  colors: { R: roof, r: 'roofDark', W: wall, w: 'wallShade', o: 'window', D: 'door' },
})

const TREE: Sprite = {
  rows: ['.L.', 'LLL', 'LLl', '.T.', '.T.'],
  colors: { L: 'leaf', l: 'leafDark', T: 'trunk' },
}
const BUSH: Sprite = { rows: ['.L.', 'LLl'], colors: { L: 'leaf', l: 'leafDark' } }

// A 1960s single-engine prop plane facing right: high wing on struts, a round
// cowling, a two-blade propeller and fixed wheels.
const PLANE: string[] = [
  '.RR...............',
  '.RRR..............',
  '.RRRR..WWWWWWWWWW.',
  '.RRRBBBSBBBBBSBCDD',
  'RBBBBBGGGGBBBGGCDD',
  'BBBBBBGGGGBBBGGCDN',
  'bTTTTTTTTTTTTTTCDN',
  '.bbbbbbbbbbbbbbbDD',
  '.....wwwwwwwww....',
  '.......K.....K.K..',
  '.......KH....KH.KH',
]
const PLANE_COLORS: Record<string, ColorName> = {
  R: 'accent', B: 'body', b: 'bodyShade', T: 'accent', G: 'glass', W: 'wing', w: 'wingShade',
  S: 'strut', C: 'cowlHi', D: 'cowl', N: 'nose', K: 'wheel', H: 'hub',
}
const PLANE_W = 18
const PLANE_H = PLANE.length
/** The row of the nose, where the propeller turns. */
const NOSE_ROW = 5

// ---- the world ---------------------------------------------------------------

const GROUND = 4 // rows of runway, grass and dirt at the bottom while on the ground
const CAM_LAG = 10 // how far above the ground the plane stays on screen once climbing
const RUNWAY_FROM = -40
const RUNWAY_TO = 22
const HOUSES_FROM = 26
const BOOM_MS = 700

/**
 * How high the plane flies at a multiplier, in pixels. Half of all rounds crash
 * before 2x, so the houses, mountains and clouds all have to pass by early:
 * about 1.3x is above the houses, 2x above the mountains, 3x in the clouds,
 * and 12x at the top of the sky.
 */
export function planeAltitude(multiplier: number): number {
  const r = Math.log(Math.max(1, multiplier)) / Math.log(12)
  return 85 * Math.min(1.15, Math.pow(r, 0.8))
}

/** Pixels the world has scrolled by since take-off. */
const distanceAt = (runMs: number): number => {
  const t = Math.min(60, Math.max(0, runMs) / 1000)
  return 14 * t + 1.2 * t * t
}

/** How long the fall lasts from a given altitude. A crash on the runway has none. */
export const fallMsFor = (alt: number): number => (alt < 0.5 ? 0 : Math.min(1800, 350 + alt * 22))

type Mode = 'parked' | 'flying' | 'falling' | 'boom' | 'wreck'

type Frame = {
  mode: Mode
  alt: number
  cam: number
  dist: number
  tilt: number // + nose up, - nose down
  fallMs: number
  alt0: number
}

export function modeOf(input: SceneInput): Mode {
  if (input.phase === 'betting') return 'parked'
  if (input.phase === 'running') return 'flying'
  const fall = fallMsFor(planeAltitude(input.multiplier))
  if (input.sinceCrashMs < fall) return 'falling'
  return input.sinceCrashMs < fall + BOOM_MS ? 'boom' : 'wreck'
}

function frameOf(input: SceneInput): Frame {
  const mode = modeOf(input)
  const alt0 = input.phase === 'betting' ? 0 : planeAltitude(input.multiplier)
  const dist = input.phase === 'betting' ? 0 : distanceAt(input.runMs)
  const fallMs = fallMsFor(alt0)
  if (mode === 'parked') return { mode, alt: 0, cam: 0, dist, tilt: 0, fallMs, alt0 }
  if (mode === 'flying') {
    return { mode, alt: alt0, cam: Math.max(0, alt0 - CAM_LAG), dist, tilt: 0.25 * clamp(alt0 / 6, 0, 1), fallMs, alt0 }
  }
  if (mode === 'falling') {
    const u = input.sinceCrashMs / fallMs
    const alt = alt0 * (1 - u * u)
    return { mode, alt, cam: Math.max(0, alt - CAM_LAG), dist, tilt: -0.55, fallMs, alt0 }
  }
  return { mode, alt: 0, cam: 0, dist, tilt: 0, fallMs, alt0 }
}

const planeX = (width: number): number => Math.floor(width * 0.28)
const groundRow = (c: Canvas, f: Frame): number => c.height - GROUND + Math.round(f.cam)

function drawSky(c: Canvas, f: Frame, seed: number): void {
  for (let y = 0; y < c.height; y++) {
    const alt = f.cam + (c.height - GROUND - 1 - y)
    const band = clamp(Math.floor(alt / 16), 0, 6)
    const edge = alt - band * 16
    for (let x = 0; x < c.width; x++) {
      const shade = edge >= 13 && band < 6 && (x + y) % 2 === 0 ? band + 1 : band
      let name: ColorName = SKY[shade]!
      if (shade >= 5 && hash(x + Math.floor(f.dist * 0.03), Math.floor(alt) + seed * 31) > 0.985) name = 'star'
      c.px[y * c.width + x] = INDEX[name]
    }
  }
  if (f.cam < 45) {
    const cy = Math.round(c.height - GROUND - 1 - (21 - f.cam * 0.2))
    c.disc(Math.floor(c.width * 0.8), cy, 3, 'sun')
  }
}

function drawMountains(c: Canvas, f: Frame, seed: number, isFar: boolean): void {
  const scrollX = isFar ? 0.2 : 0.45
  const scrollY = isFar ? 0.45 : 0.7
  const base = isFar ? 3 : 1
  const amp = isFar ? 15 : 9
  const period = isFar ? 44 : 28
  const snowAt = isFar ? 13 : 8
  const shift = hash(seed, isFar ? 11 : 12) * 10
  const top = (wx: number): number =>
    base +
    amp * (0.6 * tri(wx / period + shift) + 0.28 * tri(wx / (period * 0.43) + shift * 2.1) + 0.12 * tri(wx / (period * 0.19) + 0.7))
  for (let x = 0; x < c.width; x++) {
    const wx = Math.floor(x + f.dist * scrollX)
    const t = top(wx)
    const topRow = Math.round(c.height - GROUND - 1 - (t - f.cam * scrollY))
    const isShaded = top(wx + 1) < t
    for (let y = Math.max(0, topRow); y < c.height; y++) {
      const depth = y - topRow
      let name: ColorName
      if (t > snowAt && depth < Math.min(3, (t - snowAt) / 2 + 1)) name = isShaded ? 'snowShade' : 'snow'
      else if (isFar) name = isShaded ? 'farShade' : 'far'
      else name = isShaded ? 'nearShade' : 'near'
      c.px[y * c.width + x] = INDEX[name]
    }
  }
}

function drawCloud(c: Canvas, x: number, bottom: number, width: number): void {
  const widths = [Math.round(width * 0.45), Math.round(width * 0.75), width, width - 2]
  widths.forEach((w, r) => {
    const left = x + Math.floor((width - w) / 2) + (r === 0 ? -Math.floor(width * 0.12) : 0)
    c.rect(left, bottom - 3 + r, w, 1, r === 3 ? 'cloudShade' : 'cloud')
  })
}

function drawClouds(c: Canvas, f: Frame, seed: number, tMs: number, isLow: boolean): void {
  const scrollX = isLow ? 0.5 : 0.8
  const scrollY = isLow ? 0.4 : 1
  const spacing = isLow ? 26 : 30
  const drift = (tMs / 1000) * 1.5
  const at = f.dist * scrollX + drift
  const first = Math.floor((at - 20) / spacing) - 1
  const last = Math.floor((at + c.width) / spacing) + 1
  for (let k = first; k <= last; k++) {
    if (hash(seed + (isLow ? 7 : 3), k) < (isLow ? 0.45 : 0.3)) continue
    const wx = k * spacing + hash(k, seed) * spacing * 0.6
    const wy = isLow ? 12 + hash(seed, k + 5) * 6 : 34 + hash(k, seed + 9) * 50
    const width = 8 + Math.floor(hash(seed + k, 13) * 9)
    const x = Math.round(wx - at)
    const bottom = Math.round(c.height - GROUND - 1 - (wy - f.cam * scrollY))
    drawCloud(c, x, bottom, width)
  }
}

function drawGround(c: Canvas, f: Frame, seed: number): void {
  const top = groundRow(c, f)
  if (top >= c.height) return
  const toScreen = (wx: number): number => Math.round(wx - f.dist + planeX(c.width))
  for (let y = Math.max(0, top); y < c.height; y++) {
    const name: ColorName = y === top ? 'grass' : y === top + 1 ? 'grassDark' : 'dirt'
    c.rect(0, y, c.width, 1, name)
  }
  const from = toScreen(RUNWAY_FROM)
  const to = toScreen(RUNWAY_TO)
  for (let x = Math.max(0, from); x < Math.min(c.width, to); x++) {
    const wx = x + f.dist - planeX(c.width)
    c.set(x, top, 'runway')
    c.set(x, top + 1, (((Math.round(wx) % 8) + 8) % 8) < 4 ? 'runwayLine' : 'runway')
  }
  const slot = 13
  const first = Math.floor((f.dist - planeX(c.width) - 8) / slot)
  const last = Math.floor((f.dist + c.width) / slot) + 1
  for (let k = first; k <= last; k++) {
    const wx = k * slot + 3 + Math.floor(hash(seed, k + 100) * 5)
    if (wx < HOUSES_FROM) continue
    const kind = hash(seed + 5, k)
    const x = toScreen(wx)
    if (kind < 0.5) {
      const roof = ROOFS[Math.floor(hash(k, seed + 1) * ROOFS.length)]!
      const wall = WALLS[Math.floor(hash(k, seed + 2) * WALLS.length)]!
      stamp(c, houseSprite(roof, wall), x, top - 6)
    } else if (kind < 0.8) stamp(c, TREE, x, top - 5)
    else if (kind < 0.92) stamp(c, BUSH, x, top - 2)
  }
}

function drawPlane(c: Canvas, f: Frame, input: SceneInput): void {
  const x0 = planeX(c.width)
  const onGround = f.alt < 1.5
  const bob = f.mode === 'flying' && !onGround ? Math.round(Math.sin(input.tMs / 230)) : 0
  const bottom = c.height - GROUND - 1 - Math.round(f.alt - f.cam) + bob
  const lift = (col: number): number => Math.round(col * f.tilt)
  const burning = f.mode === 'falling'
  const rowY = (r: number, col: number): number => bottom - (PLANE_H - 1 - r) - lift(col)
  for (let r = 0; r < PLANE_H; r++) {
    for (let col = 0; col < PLANE_W; col++) {
      const ch = PLANE[r]![col]!
      if (ch === '.') continue
      let name = PLANE_COLORS[ch]!
      if (burning && hash(col + r * 13, Math.floor(input.tMs / 80)) > 0.78) name = hash(col, r + Math.floor(input.tMs / 60)) > 0.5 ? 'fireO' : 'fireY'
      c.set(x0 + col, rowY(r, col), name)
    }
  }
  // The propeller turns: blades up and down, a blur, blades edge-on, a blur.
  if (f.mode !== 'wreck' && f.mode !== 'boom') {
    const px = x0 + PLANE_W
    const cy = rowY(NOSE_ROW, PLANE_W - 1)
    const step = Math.floor(input.tMs / 55) % 4
    if (step === 0) {
      for (let dy = -4; dy <= 4; dy++) c.set(px, cy + dy, 'prop')
    } else if (step === 2) {
      c.set(px, cy - 1, 'prop')
      c.set(px, cy, 'prop')
      c.set(px, cy + 1, 'prop')
    } else {
      for (let dy = -4; dy <= 4; dy++) if (dy !== 0 || step === 1) c.set(px, cy + dy, 'propBlur')
      c.set(px - 1, cy - 2, 'propBlur')
      c.set(px - 1, cy + 2, 'propBlur')
    }
  }
  // A thin white trail behind a plane that is climbing.
  if (f.mode === 'flying' && !onGround) {
    for (let i = 2; i < 10; i += 2) c.set(x0 - i, bottom - 5 + Math.round(i * f.tilt * 0.6), 'cloud')
  }
  // Fire and smoke behind a plane that is falling.
  if (f.mode === 'falling') {
    const u = input.sinceCrashMs / f.fallMs
    for (let i = 1; i <= 11; i++) {
      const earlier = Math.max(0, u - i * 0.03)
      const alt = f.alt0 * (1 - earlier * earlier)
      const y = c.height - GROUND - 1 - Math.round(alt - f.cam) - 4
      const jitter = Math.floor(hash(i, Math.floor(input.tMs / 90)) * 3) - 1
      const name: ColorName = i < 3 ? 'fireY' : i < 5 ? 'fireO' : i < 7 ? 'fireR' : i < 9 ? 'smoke1' : 'smoke0'
      c.set(x0 - 1 - i * 2, y + jitter, name)
      if (i > 2) c.set(x0 - 2 - i * 2, y + jitter + 1, i < 8 ? 'smoke2' : 'smoke1')
    }
  }
}

function drawBoom(c: Canvas, f: Frame, input: SceneInput): void {
  const cx = planeX(c.width) + 8
  const cy = c.height - GROUND - 2
  const since = input.sinceCrashMs - f.fallMs
  if (f.mode === 'boom') {
    const grow = Math.min(7, 1 + Math.floor(since / 70))
    const fade = since > BOOM_MS - 200 ? Math.floor((since - (BOOM_MS - 200)) / 70) : 0
    const r = Math.max(2, grow - fade)
    c.disc(cx, cy, r, 'fireR')
    c.disc(cx, cy, Math.max(1, r - 2), 'fireO')
    c.disc(cx, cy, Math.max(1, r - 4), 'fireY')
    for (let i = 0; i < 10; i++) {
      const angle = hash(i, Math.floor(since / 60)) * Math.PI * 2
      const reach = r + 1 + Math.floor(hash(i + 20, Math.floor(since / 60)) * 3)
      c.set(cx + Math.round(Math.cos(angle) * reach), cy + Math.round(Math.sin(angle) * reach), i % 2 === 0 ? 'fireO' : 'smoke1')
    }
    return
  }
  // The wreck: a dark heap, a flicker of fire, a column of smoke.
  c.rect(cx - 4, cy, 9, 2, 'smoke0')
  c.rect(cx - 2, cy - 1, 5, 1, 'smoke0')
  c.set(cx - 2, cy, 'wheel')
  c.set(cx + 3, cy - 1, 'accent')
  for (let i = 0; i < 4; i++) {
    const on = hash(i, Math.floor(input.tMs / 120)) > 0.35
    if (on) c.set(cx - 2 + i * 2, cy - 2, i % 2 === 0 ? 'fireO' : 'fireY')
  }
  for (let k = 0; k < 9; k++) {
    const age = (input.tMs / 130 + k) % 9
    const y = Math.round(cy - 3 - age * 1.9)
    const x = cx + Math.round(Math.sin(age * 0.9 + k) * (0.6 + age * 0.35))
    const name: ColorName = age < 2.5 ? 'smoke0' : age < 5 ? 'smoke1' : age < 7.5 ? 'smoke2' : 'smoke3'
    c.set(x, y, name)
    c.set(x + 1, y, name)
  }
}

/** One frame of the scene: `width` x `height` palette indices, row by row. */
export function drawScene(input: SceneInput, width: number, height: number): Uint8Array {
  const c = new Canvas(width, height)
  const f = frameOf(input)
  drawSky(c, f, input.seed)
  drawMountains(c, f, input.seed, true)
  drawMountains(c, f, input.seed, false)
  drawClouds(c, f, input.seed, input.tMs, true)
  drawClouds(c, f, input.seed, input.tMs, false)
  drawGround(c, f, input.seed)
  if (f.mode === 'boom' || f.mode === 'wreck') drawBoom(c, f, input)
  else drawPlane(c, f, input)
  return c.px
}
