# Deploy the server

A small Ubuntu 24.04 machine is enough (2 vCPU, 2 GB RAM). Caddy answers on 80 and 443 and gets the
HTTPS certificate by itself. The game server listens on `127.0.0.1:8787` only, behind Caddy.

1. Put your SSH public key into `cloud-init.yaml` (`__SSH_PUBLIC_KEY__`) and create the machine with it
   as user data. It installs Caddy, fail2ban and a pinned Bun (checked against its published checksum),
   makes a `deploy` user for you and a locked-down `idlecrash` user for the service, turns off
   password and root logins, and turns on the machine's own firewall (`ufw`: only 22, 80 and 443 in).
2. Open ports 22, 80 and 443 (tcp) and 443 (udp) in the provider's firewall too, so there are two.
3. Pick a name that points at the machine. Without a domain, `203-0-113-7.sslip.io` resolves to
   `203.0.113.7`.
4. From the repo root:

   ```bash
   SSH_KEY=~/.ssh/your_key deploy/deploy.sh deploy@203.0.113.7 203-0-113-7.sslip.io ci_key.pub
   ```

   It writes the Caddyfile, installs the systemd unit (memory capped, read-only file system except the
   data folder), clones the repo to `/opt/idlecrash/repo` and runs it from there, and sets up a daily
   backup of the accounts file (14 kept). `ci_key.pub` is optional: see "Deploy on every push" below.
5. Check it with `bun server/scripts/check-remote.ts https://203-0-113-7.sslip.io`. It plays one round
   over HTTPS and a secure WebSocket.
6. Tell the mod to use it: `claude plugin configure idlecrash@grozoww-mods`, or set `serverUrl` in `/config`.

Updating is the same command again. Accounts live in `/var/lib/idlecrash/accounts.json` and survive it.
It also sets the `ufw` rules, so a machine made before the firewall was added gets it on the next run.
After kernel updates the machine asks for a reboot (`ls /var/run/reboot-required`); `sudo reboot` is safe,
both services start by themselves.

The server counts a client by its IPv4 address, or by its `/64` for IPv6 (one user holds a whole `/64`),
for the rate limit, the limit on new accounts and the limit on open sockets.

## Deploy on every push

`.github/workflows/deploy.yml` tests every push to `main` that changes `server/` or `shared/`, deploys it,
and then plays one round on the live server (`check-remote.ts`).

The workflow logs in with a key of its own, and that key can do one thing on the server: run
`/usr/local/bin/idlecrash-deploy <commit>` (a forced command, no shell, no forwarding). The script only
accepts a 40-character hash that is on `main`, checks it out in `/opt/idlecrash/repo`, restarts the one
service, and goes back to the previous commit if the server does not come up. The CI user can restart that
one service with sudo and nothing else. The game itself runs as another user, in a locked-down unit.

To set it up on your own fork:

```bash
ssh-keygen -t ed25519 -N "" -C ci -f ci_key          # a key just for this
SSH_KEY=~/.ssh/your_key deploy/deploy.sh deploy@203.0.113.7 203-0-113-7.sslip.io ci_key.pub
gh secret set DEPLOY_SSH_KEY < ci_key && rm ci_key    # the private half lives only in GitHub
gh variable set DEPLOY_HOST --body 203.0.113.7
gh variable set DEPLOY_KNOWN_HOSTS --body "$(ssh-keyscan -t ed25519 203.0.113.7)"
gh variable set PUBLIC_URL --body https://203-0-113-7.sslip.io
```

Compare the host key `ssh-keyscan` prints with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the
machine before you trust it. Changes under `deploy/` are not rolled out by the workflow, because they run
with more rights: apply them with `deploy/deploy.sh`. The `ufw` rules are one of those changes: a machine that
already exists gets them with one run of `deploy/deploy.sh`.
