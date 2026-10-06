// Turns the scene's palette indices into something a surface can draw.
import { PALETTE } from './shared/scene'

export type Run = { text: string; fg: string; bg: string }

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
