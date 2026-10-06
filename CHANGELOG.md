# Changelog

## 0.3.1

- The mod and the server now tell each other how old they are. A mod sends its protocol number with every call and
  the server answers with its own (`/health` also says the server's version), so an old mod and a new server, or
  the other way round, say so instead of failing in odd ways: a mod the server no longer serves is told to update
  (`claude plugin update idlecrash@grozoww-mods`) in the pane and in a toast, and a mod that needs a newer server
  says the server is behind. Nothing is refused yet: mods from before this count as protocol 0, and the server
  still serves them. The rules for raising the numbers are in `shared/protocol.ts`.
- Releases and deploys are one pipeline now: a push to `main` deploys the server when it changed, checks the
  live server runs this version, and then publishes the GitHub Release for the version in `plugin.json`.
  A test keeps the version in every file the same, and keeps a changelog entry for it.

## 0.3.0

- In the desktop app the game is now a pane of its own in the side panel, not a browser window. The plane, the
  header and the table are vector pictures in the web page's colors, and the buttons are pictures too: they light
  up under the pointer. All of it scales with the pane. The pane stays put when a bet is placed or a turn ends.
- The desktop app sends typed keys to the chat, so a pane there has no keyboard: use the mouse. While the mouse
  button is held down the app pauses the whole side panel; it catches up when you let go.
- **The browser version is gone.** The server no longer serves a page or a WebSocket, and `/link` is gone;
  the mod no longer opens a browser, so `/idlecrash web`, `/idlecrash link` and the setting `browser` are gone.
  It plays only in a terminal and in the desktop app, and does nothing in an editor or on a phone. A pane that
  the app does not place by itself waits for `/idlecrash`. The mod runs no program on your machine any more.
  Mods older than 0.3.0 open the page, so they stop working once the new server is deployed: update the mod.
- When Claude stops, an open bet is no longer cashed out for you. New bets stay locked, but the bet stays in its
  round and you can still cash out, in the terminal pane, the desktop pane and on the page, until the plane
  crashes; an auto cash-out still pays, and a bet left alone at the crash is lost. This is a rule of the server,
  so it needs the new server: an older one still cashes the bet out at that moment, and the mod says so.
- The terminal pane: spaces between the stakes, the picked stake in brackets, a blank line before the buttons.

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
