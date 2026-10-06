import { describe, expect, test } from 'bun:test'

import {
  PALETTE,
  colorIndex,
  drawScene,
  fallMsFor,
  modeOf,
  planeAltitude,
  sceneInputFor,
  type ColorName,
  type SceneInput,
  type SceneProps,
} from './scene'

const W = 48
const H = 28
const msFor = (m: number): number => (Math.log(m) / 0.12) * 1000

const parked = (seed = 3): SceneInput => ({ phase: 'betting', multiplier: 1, runMs: 0, sinceCrashMs: 0, tMs: 200, seed })
const flying = (m: number, seed = 3): SceneInput => ({ phase: 'running', multiplier: m, runMs: msFor(m), sinceCrashMs: 0, tMs: 500, seed })
const crashed = (m: number, since: number, seed = 3): SceneInput => ({ phase: 'crashed', multiplier: m, runMs: msFor(m), sinceCrashMs: since, tMs: 900, seed })

const has = (px: Uint8Array, ...names: ColorName[]): boolean => names.some(n => px.includes(colorIndex(n)))
const count = (px: Uint8Array, name: ColorName): number => px.filter(v => v === colorIndex(name)).length
const ROOFS: ColorName[] = ['roofRed', 'roofBlue', 'roofBrown']

describe('drawing', () => {
  test('every pixel is a palette color, and the same input draws the same picture', () => {
    const a = drawScene(flying(2.2), W, H)
    expect(a).toHaveLength(W * H)
    expect(a.every(v => v > 0 && v < PALETTE.length)).toBe(true)
    expect(Array.from(drawScene(flying(2.2), W, H))).toEqual(Array.from(a))
    expect(Array.from(drawScene(flying(2.2, 4), W, H))).not.toEqual(Array.from(a))
  })

  test('it holds for every multiplier from the runway to the top of the sky', () => {
    for (const m of [1, 1.01, 1.5, 3, 12, 80, 1000]) {
      for (const phase of ['running', 'crashed'] as const) {
        const input = phase === 'running' ? flying(m) : crashed(m, 500)
        expect(drawScene(input, W, H).every(v => v > 0 && v < PALETTE.length)).toBe(true)
      }
    }
  })
})

describe('the flight', () => {
  test('starts on the ground: runway and grass, no space', () => {
    const px = drawScene(parked(), W, H)
    expect(has(px, 'runway')).toBe(true)
    expect(has(px, 'grass')).toBe(true)
    expect(has(px, 'sky6', 'star')).toBe(false)
  })

  test('houses pass by the runway at take-off, in most rounds', () => {
    let rounds = 0
    for (let seed = 1; seed <= 8; seed++) {
      const seen = [parked(seed), flying(1.05, seed), flying(1.15, seed), flying(1.25, seed)].some(i => has(drawScene(i, W, H), ...ROOFS))
      if (seen) rounds += 1
    }
    expect(rounds).toBeGreaterThanOrEqual(6)
  })

  test('then mountains below, then clouds, then the dark sky', () => {
    const mountains = drawScene(flying(1.8), W, H)
    expect(has(mountains, 'far', 'near')).toBe(true)
    expect(has(mountains, 'grass', 'runway')).toBe(false) // the ground is gone
    expect(has(drawScene(flying(3.2), W, H), 'cloud')).toBe(true)
    expect(has(drawScene(flying(15), W, H), 'sky6', 'star')).toBe(true)
  })

  test('the plane climbs: higher on screen at 1.1x than parked, and the camera follows after that', () => {
    const rowOf = (px: Uint8Array, name: ColorName): number => px.indexOf(colorIndex(name)) / W
    const low = rowOf(drawScene(parked(), W, H), 'accent')
    const up = rowOf(drawScene(flying(1.1), W, H), 'accent')
    expect(Math.floor(up)).toBeLessThan(Math.floor(low))
    // Once climbing, the plane holds one height on screen while the world moves.
    expect(Math.floor(rowOf(drawScene(flying(5), W, H), 'accent'))).toBe(Math.floor(rowOf(drawScene(flying(9), W, H), 'accent')))
  })

  test('altitude only goes up with the multiplier', () => {
    let last = -1
    for (let m = 1; m <= 40; m += 0.25) {
      const alt = planeAltitude(m)
      expect(alt).toBeGreaterThanOrEqual(last)
      last = alt
    }
    expect(planeAltitude(1)).toBe(0)
    expect(planeAltitude(1.3)).toBeGreaterThan(8)
    expect(planeAltitude(1.3)).toBeLessThan(18)
    expect(planeAltitude(12)).toBeGreaterThan(80)
  })
})

describe('the crash', () => {
  test('falls, then explodes, then smokes', () => {
    const fall = fallMsFor(planeAltitude(8))
    expect(modeOf(crashed(8, 10))).toBe('falling')
    expect(modeOf(crashed(8, fall + 100))).toBe('boom')
    expect(modeOf(crashed(8, fall + 2000))).toBe('wreck')
    expect(has(drawScene(crashed(8, fall * 0.5), W, H), 'fireY', 'fireO', 'fireR')).toBe(true)
    expect(count(drawScene(crashed(8, fall + 250), W, H), 'fireR')).toBeGreaterThan(10)
    const wreck = drawScene(crashed(8, fall + 2000), W, H)
    expect(has(wreck, 'smoke0', 'smoke1')).toBe(true)
    expect(has(wreck, 'body')).toBe(false) // no plane any more
  })

  test('a crash on the runway has no fall; a long climb has a longer one, capped', () => {
    expect(fallMsFor(planeAltitude(1))).toBe(0)
    expect(modeOf(crashed(1, 0))).toBe('boom')
    expect(fallMsFor(planeAltitude(2))).toBeLessThan(fallMsFor(planeAltitude(10)))
    expect(fallMsFor(1e6)).toBe(1800)
  })

  test('the picture ends on the ground whatever height it fell from', () => {
    for (const m of [1.3, 3, 20]) {
      const fall = fallMsFor(planeAltitude(m))
      expect(has(drawScene(crashed(m, fall + 300), W, H), 'grass')).toBe(true)
    }
  })
})

describe('time', () => {
  const props: SceneProps = {
    phase: 'running',
    round: 1,
    columns: W,
    rows: 12,
    growth: 0.12,
    runStartedAt: 10_000,
    crashedAt: null,
    crashPoint: null,
    bettingEndsAt: 10_000,
    serverNow: 10_000 + msFor(2),
    stake: 50,
  }

  test('the multiplier follows the server clock plus the time since the props were made', () => {
    expect(sceneInputFor(props, 0).multiplier).toBe(2)
    expect(sceneInputFor(props, 1000).multiplier).toBeGreaterThan(2.2)
    expect(sceneInputFor(props, -500).multiplier).toBe(2) // never runs backwards
  })

  test('after a crash it shows the crash point and counts time since', () => {
    const after = sceneInputFor({ ...props, phase: 'crashed', crashedAt: 20_000, crashPoint: 3.4, serverNow: 20_300 }, 200)
    expect(after.multiplier).toBe(3.4)
    expect(after.input.sinceCrashMs).toBe(500)
  })
})
