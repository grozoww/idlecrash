// Turns the scene's palette indices into something a surface can draw.
import { PALETTE } from './shared/scene'

export type Run = { text: string; fg: string; bg: string }

/**
 * The scene as SVG paths, one per color, in scene pixels: put them in a group that is scaled up. Runs of one
 * color merge along a row, so a whole scene is a few kilobytes, and nothing leaves a gap the way glyph rows do.
 */
export function picturePaths(px: Uint8Array, width: number, height: number): string {
  const paths = new Map<number, string>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; ) {
      const color = px[y * width + x]!
      let len = 1
      while (x + len < width && px[y * width + x + len] === color) len += 1
      paths.set(color, `${paths.get(color) ?? ''}M${x} ${y}h${len}v1h-${len}z`)
      x += len
    }
  }
  let body = ''
  for (const [color, d] of paths) body += `<path fill="${PALETTE[color]}" d="${d}"/>`
  return body
}

/**
 * One row of terminal cells from two rows of pixels. Each cell is a half block:
 * the top pixel is its foreground, the bottom pixel its background. Cells with
 * the same colors are merged into one run.
 */
export function cellRow(px: Uint8Array, width: number, row: number): Run[] {
  const runs: Run[] = []
  for (let x = 0; x < width; x++) {
    const fg = PALETTE[px[row * 2 * width + x]!]!
    const bg = PALETTE[px[(row * 2 + 1) * width + x]!]!
    const last = runs[runs.length - 1]
    if (last && last.fg === fg && last.bg === bg) last.text += '▀'
    else runs.push({ text: '▀', fg, bg })
  }
  return runs
}
