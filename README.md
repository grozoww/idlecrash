# IdleCrash

Bet fake tokens in a Crash game with other people who are also waiting for Claude.

You send Claude a task. A pixel-art 1960s prop plane takes off. Everyone at your table bets before
take-off and cashes out before the plane crashes. When Claude finishes, betting locks and you are
back to work.

- **No real money.** Tokens are fake. They cannot be bought, sold or withdrawn.
- **Only while Claude works.** Betting is open while any of your Claude Code sessions is working and
  locks when the last one stops. An open bet stays in its round: you can still cash out until the plane
  crashes (an auto cash-out still works), and the round plays out on screen. If it crashes first, the
  stake is lost.
- **5 to 10 people per table.** Rounds run on the server's clock, so nobody waits for anybody. Bots may
  fill up to 30% of a table and are marked with a gear (⚙).
- **Terminal or desktop app.** In a terminal and in the desktop app the game is a pane next to the chat.
  It does not play in editors or on a phone.

![The plane over the runway, the houses, the mountains, the clouds, then the fall](docs/scene.png)

## Install

You need Claude Code 2.1.291 or newer. Mods are early access, so the API can change between releases
and a newer build may need an update of this mod.

```bash
claude plugin marketplace add grozoww/idlecrash
claude plugin install idlecrash@grozoww-mods
```

Restart Claude Code and send it any task. The game opens by itself the first time Claude starts working.
Type `/idlecrash` to open it yourself at any time.

To remove it: `claude plugin uninstall idlecrash`.

## Play

In a terminal the game is a pane. It opens by itself in a window at least 144 columns wide; in a narrower
one, type `/idlecrash`. Click the pane, or press `ctrl+x` and then `tab`, to give it the keyboard. Then:

| Key | Does |
| --- | --- |
| `b` | Bet your stake in the betting phase |
| `c` | Cash out while the plane flies |
| `1` `2` `3` `4` | Stake: 10, 50, 100, 500 |
| `x` | Cycle the auto cash-out: off, 1.5x, 2x, 3x, 5x, 10x |
| `r` | Bet again every round |

In the desktop app the game is a pane in the side panel: the picture, the table and the buttons. Click the
buttons. The app sends typed keys to the chat, so a pane gets no keyboard there. The pane opens by itself when
Claude starts working; type `/idlecrash` if it does not. While you hold the mouse button down the app pauses the
whole side panel, and it catches up when you let go.

Auto cash-out is paid by the server at exactly that number, so you can leave the game alone. You start
with 1000 tokens. If you go broke you get 200 back, at most once every 10 minutes. The payout is the stake
times the multiplier, rounded down: 50 cashed out at 2.00x pays 100, a profit of 50.

Commands in Claude Code:

- `/idlecrash` opens the game pane
- `/idlecrash off` and `/idlecrash on`: open the game by itself when Claude starts working, or not
- `/idlecrash name <nickname>` changes your nickname
- `/idlecrash top` shows the richest players

## The server

The mod plays on a server run by the author, at `https://178-105-28-170.sslip.io`. It is a small machine
and has no promise of uptime. When it is down the mod does nothing and the pane says it cannot reach it. The
address is the `serverUrl` setting:

```bash
claude plugin install idlecrash@grozoww-mods --config serverUrl=https://your-server.example
```

or later in `/config`. You can run your own: see [Run a server](#run-a-server).

## What the server sees

- Your nickname, a random anonymous id and secret (made on first use, kept in the plugin's store on your
  machine), your bets and cash-outs.
- Which of your Claude Code sessions are working, as a yes or no with a random session id. Never what
  they work on.
- Your IP address, like any web server. It is used for rate limiting in memory and not written to disk.

It never sees your prompts, your code, your files or anything else about your session. The mod only talks
to the one address in `serverUrl`, and it runs no program on your machine. Nicknames show to everyone at
your table and on the top list: keep them friendly.

## Run a server

The server is one Bun process with no database. Accounts live in a JSON file. It speaks HTTP and nothing else: no page, no WebSocket.

```bash
cd server
bun src/server.ts        # the API on http://localhost:8787
```

| Env | Default | |
| --- | --- | --- |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` behind a reverse proxy |
| `DATA_DIR` | `./data` | Where `accounts.json` is kept |
| `BOT_PCT` | `30` | Bots are at most this percent of a table |
| `TRUST_PROXY` | unset | Set to `1` behind a proxy so limits use `X-Forwarded-For` |
| `ACCOUNTS_PER_IP_HOUR` | `10` | New accounts per address per hour |

Put it behind HTTPS before sharing it. The mod sends a secret in a header, so plain `http://` is only fine
for `localhost`. [`deploy/`](deploy/README.md) has a cloud-init file, a systemd unit, a Caddyfile and a
one-command deploy for a small Ubuntu machine.

Point your mod at it with `serverUrl` (for a local one, `http://localhost:8787`).

To try it alone with a lively table, start six fake players for 50 seconds:

```bash
bun server/scripts/smoke.ts http://localhost:8787 6
```

To work on the server without Claude Code, `bun server/scripts/fake-mod.ts` makes an account, sits at a table and
says "Claude is working" every 2 seconds.

## How it works

- Each round has a betting phase (8 s), a flight and a crash. The server picks the crash point after
  betting closes: the chance of reaching `x` is 0.99 / `x`, so the house edge is 1%. It never sends the
  crash point before the crash.
- The mod asks the server for the table about three times a second while the plane flies and once a second
  otherwise, and draws the plane itself from the server's clock. The server, not your screen, decides
  whether a cash-out came in time.
- The mod tells the server every 2 seconds that a session is working. If the beats stop (Claude Code closed
  or crashed), the table locks by itself. In a terminal the pane draws the picture with a `Client`, which has
  its own frame clock, so the buttons are not redrawn while the plane moves. In the desktop app the picture
  is a vector image the mod redraws eight times a second; a `Client` cannot hold an image there, and nothing
  in an image can be pressed, so each button is a picture with the same picture lit over it on hover and a
  `Client` over both that catches the click.
- A player is whoever holds the account secret; there is no login. Lose the plugin's store and you start
  again with a new account.

## Develop

```bash
bun test ./server ./shared       # engine, scene, end-to-end tests (they start a server on a spare port)
cd mod && claude plugin validate . && claude plugin test .
bun tools/preview-scene.ts       # draws the pixel art to /tmp/idlecrash-scene.png
bun tools/sync-shared.ts         # after editing shared/: copies it into the mod
claude --plugin-dir "$PWD/mod"   # load the mod from this checkout
```

`shared/` holds the scene and helpers the mod uses. A plugin installed from a marketplace
gets only its own folder, so `mod/hooks/shared/` is a generated copy; `bun test` fails when it is stale.

## License

MIT, see [LICENSE](LICENSE).
