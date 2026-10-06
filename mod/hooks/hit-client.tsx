// Draws nothing. It lies over the picture of a button and posts the button's press when the pointer goes down and up
// on it. Nothing in an Svg can be pressed, but a Client is told where the pointer is, so this is the button.
// It is 12 rows tall whatever the picture is, and the Box it sits in clips it to the picture: a percentage height
// collapses to one row. It cannot call the plugin: a press is posted as data (`DeskPress`) and the plugin acts on it.
import type { ClientModule } from 'claude-code'

import type { DeskPress } from './desk'

const Hit: ClientModule<{ press: DeskPress }, boolean> = (props, surface) => {
  const { Box } = surface.elements
  // Set on every render, so a press posts what the button says now, not what it said when it appeared.
  surface.onPointer(e => {
    const isInside = e.x >= 0 && e.y >= 0 && e.x < surface.columns && e.y < surface.rows
    const down = surface.state ?? false
    if (e.type === 'down' && e.button === 'left') {
      if (!down) surface.setState(true)
    } else if (e.type === 'up') {
      if (down && isInside) surface.post(props.press)
      if (down) surface.setState(false)
    } else if (e.type === 'leave' && down) surface.setState(false)
  })
  return <Box width="100%" height={12} />
}

export default Hit
