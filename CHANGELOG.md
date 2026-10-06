# Changelog

## 0.2.1

- When the app's browser panel cannot be used, `/idlecrash` now says why (no such tool in this session, the
  call was refused, an error) instead of silently opening your default browser.

## 0.2.0

- After Claude finishes you can watch the round to its end: the plane, the crash and the table stay on
  screen, betting is locked, and an open bet is still cashed out for you at that moment.
- In the desktop app the game opens in the app's own browser panel, not in an outside browser
  (setting `browser`: `auto`, `app` or `system`).
- A refusal now says why ("Claude is not working, betting is locked"), and a code with no words is shown as it is.
- The server deploys itself when `main` changes (GitHub Actions, with a key that can only deploy a commit from `main`).

## 0.1.0

First release.

- Crash with fake tokens while Claude works: a pixel-art 1960s prop plane, rounds on the server's clock.
- In a terminal the game lives in a pane. In the desktop app and in editors it opens in your browser.
- Betting is open while any of your Claude Code sessions is working, and locks when the last one stops.
- Bots fill at most 30% of a table and are marked with a gear.
