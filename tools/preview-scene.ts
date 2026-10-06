// Draws a contact sheet of the pixel-art scene to a PNG, so it can be looked at.
// Usage: bun tools/preview-scene.ts [out.png]
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { PALETTE, drawScene, fallMsFor, planeAltitude, type SceneInput } from '../shared/scene'

const W = 48
const H = 28
const SCALE = Number(process.env.SCALE ?? 6)
const COLS = 3

const run = (m: number, runMs: number): SceneInput => ({ phase: 'running', multiplier: m, runMs, sinceCrashMs: 0, tMs: 500, seed: 3 })
const crashed = (m: number, since: number): SceneInput => ({ phase: 'crashed', multiplier: m, runMs: 30_000, sinceCrashMs: since, tMs: 900, seed: 3 })
const fall = fallMsFor(planeAltitude(8))

const msFor = (m: number) => (Math.log(m) / 0.12) * 1000
const fly = (m: number) => run(m, msFor(m))
const frames: [string, SceneInput][] = [
  ['parked', { phase: 'betting', multiplier: 1, runMs: 0, sinceCrashMs: 0, tMs: 200, seed: 3 }],
  ['rolling 1.03x', fly(1.03)],
  ['takeoff 1.10x', fly(1.1)],
  ['houses 1.2x', fly(1.2)],
  ['mountains 1.6x', fly(1.6)],
  ['mountains 2.2x', fly(2.2)],
  ['clouds 3.2x', fly(3.2)],
  ['clouds 5x', fly(5)],
  ['high 12x', fly(12)],
  ['falling', crashed(8, fall * 0.35)],
  ['falling late', crashed(8, fall * 0.85)],
  ['boom', crashed(8, fall + 250)],
  ['wreck', crashed(8, fall + 1500)],
  ['crash 1.00x', crashed(1, 400)],
  ['crash 1.3x early', crashed(1.3, 200)],
]

const rows = Math.ceil(frames.length / COLS)
const gap = 2
const sheetW = COLS * (W + gap) + gap
const sheetH = rows * (H + gap) + gap
const rgb = PALETTE.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)))
const img = new Uint8Array(sheetW * SCALE * sheetH * SCALE * 3).fill(40)
frames.forEach(([, input], k) => {
  const px = drawScene(input, W, H)
  const ox = gap + (k % COLS) * (W + gap)
  const oy = gap + Math.floor(k / COLS) * (H + gap)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = rgb[px[y * W + x]!]!
    for (let j = 0; j < SCALE; j++) for (let i = 0; i < SCALE; i++) {
      const o = (((oy + y) * SCALE + j) * sheetW * SCALE + (ox + x) * SCALE + i) * 3
      img[o] = r!; img[o + 1] = g!; img[o + 2] = b!
    }
  }
})

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buf: Uint8Array) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length); const v = new DataView(out.buffer)
  v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8)
  v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out
}
const width = sheetW * SCALE, height = sheetH * SCALE
const raw = new Uint8Array((width * 3 + 1) * height)
for (let y = 0; y < height; y++) raw.set(img.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer); iv.setUint32(0, width); iv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 2
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
const out = process.argv[2] ?? '/tmp/idlecrash-scene.png'
writeFileSync(out, png)
console.log(`${out}  ${width}x${height}  frames: ${frames.map(f => f[0]).join(', ')}`)
