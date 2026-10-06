// The animated picture, drawn on the surface itself. It runs its own frame
// clock, so the plugin never redraws the pane (and its buttons) to move a plane.
import type { ClientModule } from 'claude-code'

import { fmt, payoutFor, seconds, times } from './shared/lib'
import { cellRow } from './pixels'
import { drawScene, sceneInputFor } from './shared/scene'
import type { SceneProps } from './shared/scene'

const FRAME_MS = 100

/** `n` frames since the props arrived, `at` and `t` wall-clock readings of then and now. */
type Clock = { n: number; at: number; t: number; stamp: number }

const Scene: ClientModule<SceneProps, Clock> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state
  if (state === undefined) {
    const t = Date.now()
    surface.setState({ n: 0, at: t, t, stamp: props.serverNow })
    surface.every(FRAME_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, n: cur.n + 1, t: Date.now() })
    })
  } else if (state.stamp !== props.serverNow) {
    // New props from the plugin: measure time from here.
    const t = Date.now()
    surface.setState({ n: 0, at: t, t, stamp: props.serverNow })
  }
  const clock = surface.state ?? { n: 0, at: 0, t: 0, stamp: props.serverNow }
  // Whichever ran further: the frames we counted, or the wall clock (if frames stalled).
  const elapsed = clock.stamp === props.serverNow ? Math.max(clock.n * FRAME_MS, clock.t - clock.at) : 0
  const { input, multiplier, serverNow } = sceneInputFor(props, elapsed)
  const px = drawScene(input, props.columns, props.rows * 2)

  let line
  if (props.phase === 'betting') {
    line = (
      <Text bold color="warning">
        BETS OPEN  {seconds(props.bettingEndsAt - serverNow)}s
      </Text>
    )
  } else if (props.phase === 'running') {
    line = (
      <Text bold color="success">
        ▲ {times(multiplier)}
        {props.stake > 0 ? `   cash out now: ${fmt(payoutFor(props.stake, multiplier))}` : ''}
      </Text>
    )
  } else {
    line = (
      <Text bold color="error">
        ✖ CRASHED at {times(multiplier)}
      </Text>
    )
  }

  const rows = []
  for (let r = 0; r < props.rows; r++) {
    rows.push(
      <Box>
        {cellRow(px, props.columns, r).map(run => (
          <Text color={run.fg} backgroundColor={run.bg}>
            {run.text}
          </Text>
        ))}
      </Box>,
    )
  }
  return (
    <Box flexDirection="column">
      {rows}
      {line}
    </Box>
  )
}

export default Scene
