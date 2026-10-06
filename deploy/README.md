# Deploy the server

A small Ubuntu 24.04 machine is enough (2 vCPU, 2 GB RAM). Caddy answers on 80 and 443 and gets the
HTTPS certificate by itself. The game server listens on `127.0.0.1:8787` only, behind Caddy.

1. Put your SSH public key into `cloud-init.yaml` (`__SSH_PUBLIC_KEY__`) and create the machine with it
   as user data. It installs Caddy, fail2ban and a pinned Bun (checked against its published checksum),
   makes a `deploy` user for you and a locked-down `idlecrash` user for the service, and turns off
   password and root logins.
2. Open ports 22, 80 and 443 (tcp) and 443 (udp) in the provider's firewall.
3. Pick a name that points at the machine. Without a domain, `203-0-113-7.sslip.io` resolves to
   `203.0.113.7`.
4. From the repo root:

   ```bash
   SSH_KEY=~/.ssh/your_key deploy/deploy.sh deploy@203.0.113.7 203-0-113-7.sslip.io
   ```

   It copies `server/` and `shared/`, writes the Caddyfile, installs the systemd unit (memory capped,
   read-only file system except the data folder), restarts both services and sets up a daily backup of the
   accounts file (14 kept).
5. Check it with `bun server/scripts/check-remote.ts https://203-0-113-7.sslip.io`. It plays one round
   over HTTPS and a secure WebSocket.
6. Tell the mod to use it: `claude plugin configure idlecrash@grozoww-mods`, or set `serverUrl` in `/config`.

Updating is the same command again. Accounts live in `/var/lib/idlecrash/accounts.json` and survive it.
