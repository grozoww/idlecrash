// Draws the desktop pane as a web page, from the same functions the plugin uses, so it can be looked at and
// photographed for the README. The data is made up: a round in flight with a bet on it.
// Usage: bun tools/preview-desk.ts [out.html]
// To a PNG (Chrome headless; the page is 736 wide):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --hide-scrollbars \
//     --force-device-scale-factor=2 --window-size=736,1016 --screenshot=docs/pane.png file:///tmp/idlecrash-pane.html
import { writeFileSync } from 'node:fs'
import { PICTURE, controlsOf, deskView } from '../mod/hooks/desk'
import type { ButtonSpec } from '../mod/hooks/desk'
import { buttonSvg, captionSvg, overlayOf, stageSvg, statusSvg, tableSvg } from '../mod/hooks/desk-svg'
import { picturePaths } from '../mod/hooks/pixels'
import { drawScene, sceneInputFor } from '../mod/hooks/shared/scene'
import type { SceneProps } from '../mod/hooks/shared/scene'
import type { Snapshot } from '../mod/hooks/shared/types'

const MULTIPLIER = Number(process.env.MULTIPLIER ?? 3.2)
const GROWTH = 0.12
const now = 1_800_000_000_000
const runMs = (Math.log(MULTIPLIER) / GROWTH) * 1000

const snap: Snapshot = {
  now,
  growth: GROWTH,
  table: {
    id: 't1',
    round: 3,
    phase: 'running',
    phaseStartedAt: now - runMs - 8000,
    bettingEndsAt: now - runMs,
    runStartedAt: now - runMs,
    crashedAt: null,
    crashPoint: null,
    humans: 5,
    bots: 2,
  },
  players: [
    { name: 'Dana', bot: false, you: true, bet: 100, cash: null, payout: 0 },
    { name: 'Mika', bot: false, you: false, bet: 50, cash: 1.8, payout: 90 },
    { name: 'Tomas', bot: false, you: false, bet: 500, cash: 2.4, payout: 1200 },
    { name: 'Sana', bot: false, you: false, bet: 10, cash: null, payout: 0 },
    { name: 'Leo', bot: false, you: false, bet: 0, cash: null, payout: 0 },
    { name: 'Orbit', bot: true, you: false, bet: 200, cash: null, payout: 0 },
    { name: 'Pixel', bot: true, you: false, bet: 20, cash: 1.5, payout: 30 },
  ],
  history: [2.31, 1.12, 5.8, 1.0, 3.45, 1.67, 12.9, 1.24, 2.02, 1.33],
  you: { name: 'Dana', balance: 1240, bet: { amount: 100, auto: 5, cash: null, payout: 0 }, refillAt: null },
  limits: { minBet: 10, maxBet: 1000 },
}

const view = deskView(
  snap,
  { stake: 100, auto: 5, isRebet: true },
  { isWorking: true, isJoined: true, isWatching: false, error: null, note: null, balanceAtStart: 1000, summary: null },
  now,
)
const controls = controlsOf(view.controls)!

const props: SceneProps = { ...view.scene!, columns: PICTURE.width, rows: PICTURE.height / 2 }
const { input, multiplier, serverNow } = sceneInputFor(props, 0)
const overlay = overlayOf(view.scene!, multiplier, serverNow)
const picture = picturePaths(drawScene(input, PICTURE.width, PICTURE.height), PICTURE.width, PICTURE.height)
const stage = stageSvg({ head: view.head, picture, big: overlay.big, bigColor: overlay.color, sub: overlay.sub, watch: null, message: null })

const face = (b: ButtonSpec) => buttonSvg(b, 'rest')
const row = (parts: string[]) => `<div class="row">${parts.join('')}</div>`
const main = 'button' in controls.main ? face(controls.main.button) : statusSvg(controls.main.text, controls.main.color)

const html = `<!doctype html>
<meta charset="utf-8">
<title>IdleCrash pane</title>
<style>
  body { margin: 0; background: #0b0c10; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a93ab; }
  .pane { width: 704px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; }
  svg { display: block; }
</style>
<div class="pane">
  ${stage}
  <div>
    ${main}
    ${row([captionSvg('stake'), ...controls.stakes.map(face)])}
    ${row(controls.options.map(face))}
  </div>
  ${tableSvg(view.table!)}
  <div>Fake tokens only. Nothing here is worth anything. Bets are open only while Claude is working.</div>
</div>
`

const out = process.argv[2] ?? '/tmp/idlecrash-pane.html'
writeFileSync(out, html)
console.log(`wrote ${out}`)
