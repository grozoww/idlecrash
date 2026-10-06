#!/usr/bin/env bash
# Copies the server to a machine set up with cloud-init.yaml and (re)starts it.
#
#   deploy/deploy.sh deploy@203.0.113.7 203-0-113-7.sslip.io
#
# Set SSH_KEY to the private key to use. Caddy gets the HTTPS certificate by itself.
set -euo pipefail
TARGET=${1:?usage: deploy.sh user@host public-hostname}
HOST=${2:?usage: deploy.sh user@host public-hostname}
cd "$(dirname "$0")/.."

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$@"; }
export RSYNC_RSH="ssh ${SSH_OPTS[*]}"

rsync -az --delete --exclude node_modules --exclude data server/ "$TARGET:/opt/idlecrash/server/"
rsync -az --delete shared/ "$TARGET:/opt/idlecrash/shared/"
sed "s/__HOST__/$HOST/g" deploy/Caddyfile.template | ssh_ "$TARGET" 'sudo tee /etc/caddy/Caddyfile >/dev/null'
scp "${SSH_OPTS[@]}" deploy/idlecrash.service "$TARGET:/tmp/idlecrash.service"
ssh_ "$TARGET" 'sudo install -m 0644 /tmp/idlecrash.service /etc/systemd/system/idlecrash.service \
  && sudo systemctl daemon-reload && sudo systemctl enable idlecrash && sudo systemctl restart idlecrash \
  && sudo systemctl restart caddy'
# A copy of the accounts file every day, 14 kept.
ssh_ "$TARGET" 'sudo install -d -o idlecrash -g idlecrash -m 0750 /var/backups/idlecrash && sudo tee /etc/cron.daily/idlecrash-backup >/dev/null <<"EOS"
#!/bin/sh
f=/var/lib/idlecrash/accounts.json
[ -f "$f" ] && cp "$f" "/var/backups/idlecrash/accounts-$(date +%F).json" && chown idlecrash:idlecrash /var/backups/idlecrash/*.json
find /var/backups/idlecrash -name "accounts-*.json" -mtime +14 -delete
EOS
sudo chmod 0755 /etc/cron.daily/idlecrash-backup'
echo "deployed: https://$HOST/health"
