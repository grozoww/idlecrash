#!/usr/bin/env bash
# Sets a machine up (made with cloud-init.yaml) to run the server, or brings it up to date.
#
#   deploy/deploy.sh deploy@203.0.113.7 203-0-113-7.sslip.io [ci-public-key-file]
#
# The code comes from the public git repo (REPO_URL, default this one) at REF (default main).
# With a public key file it also lets that key deploy later, and nothing else: see idlecrash-deploy.
# Set SSH_KEY to the private key to log in with. Caddy gets the HTTPS certificate by itself.
set -euo pipefail
TARGET=${1:?usage: deploy.sh user@host public-hostname [ci-public-key-file]}
HOST=${2:?usage: deploy.sh user@host public-hostname [ci-public-key-file]}
CI_KEY_FILE=${3:-}
REPO_URL=${REPO_URL:-https://github.com/grozoww/idlecrash.git}
REF=${REF:-main}
cd "$(dirname "$0")/.."

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$@"; }

# The files that run with more rights than the game come from here, never from the checkout.
sed "s/__HOST__/$HOST/g" deploy/Caddyfile.template | ssh_ "$TARGET" 'sudo tee /etc/caddy/Caddyfile >/dev/null'
scp -q "${SSH_OPTS[@]}" deploy/idlecrash.service deploy/idlecrash-deploy "$TARGET:/tmp/"
CI_LINE=""
[ -n "$CI_KEY_FILE" ] && CI_LINE="restrict,command=\"/usr/local/bin/idlecrash-deploy\" $(cat "$CI_KEY_FILE")"
# base64, so no shell on the way eats the quotes around the forced command
CI_B64=$(printf '%s' "$CI_LINE" | base64 | tr -d '\n')

ssh_ "$TARGET" bash -s -- "$REPO_URL" "$REF" "$CI_B64" <<'REMOTE'
set -euo pipefail
# ${3:-}: without a CI key $3 is empty, and ssh drops an empty argument, so it is not set at all
repo_url=$1; ref=$2; ci_line=$(printf '%s' "${3:-}" | base64 -d)

# A user for CI: no sudo, except restarting the one service. It owns the code checkout.
id cideploy >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash cideploy
echo 'cideploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart idlecrash' | sudo tee /etc/sudoers.d/idlecrash-deploy >/dev/null
sudo chmod 0440 /etc/sudoers.d/idlecrash-deploy
sudo visudo -cf /etc/sudoers.d/idlecrash-deploy >/dev/null
sudo install -m 0755 -o root -g root /tmp/idlecrash-deploy /usr/local/bin/idlecrash-deploy
if [ -n "$ci_line" ]; then
  sudo install -d -o cideploy -g cideploy -m 0700 /home/cideploy/.ssh
  printf '%s\n' "$ci_line" | sudo -u cideploy tee /home/cideploy/.ssh/authorized_keys >/dev/null
  sudo chmod 0600 /home/cideploy/.ssh/authorized_keys
fi

# The code, from git.
sudo install -d -o cideploy -g cideploy -m 0755 /opt/idlecrash
[ -d /opt/idlecrash/repo/.git ] || sudo -u cideploy git clone --quiet "$repo_url" /opt/idlecrash/repo
sudo -u cideploy git -C /opt/idlecrash/repo fetch --quiet origin
sudo -u cideploy git -C /opt/idlecrash/repo checkout --quiet --detach "origin/$ref"
sudo rm -rf /opt/idlecrash/server /opt/idlecrash/shared # the layout before git

sudo install -m 0644 /tmp/idlecrash.service /etc/systemd/system/idlecrash.service
sudo systemctl daemon-reload
sudo systemctl enable idlecrash >/dev/null 2>&1
sudo systemctl restart idlecrash
sudo systemctl restart caddy

# A copy of the accounts file every day, 14 kept.
sudo install -d -o idlecrash -g idlecrash -m 0750 /var/backups/idlecrash
sudo tee /etc/cron.daily/idlecrash-backup >/dev/null <<"EOS"
#!/bin/sh
f=/var/lib/idlecrash/accounts.json
[ -f "$f" ] && cp "$f" "/var/backups/idlecrash/accounts-$(date +%F).json" && chown idlecrash:idlecrash /var/backups/idlecrash/*.json
find /var/backups/idlecrash -name "accounts-*.json" -mtime +14 -delete
EOS
sudo chmod 0755 /etc/cron.daily/idlecrash-backup

# The machine's own firewall: only ssh, http, https and http/3 come in. The same rules as in cloud-init.yaml,
# and safe to repeat, so a machine that was set up before this existed gets it now. ssh is allowed before the
# firewall is turned on, and a connection that is already open stays open, so this cannot lock you out.
# `allow`, not `limit` for ssh: this script and the CI deploy open several connections in a row.
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow 22/tcp >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw allow 443/udp >/dev/null
sudo ufw --force enable
REMOTE
echo "deployed $REF: https://$HOST/health"
