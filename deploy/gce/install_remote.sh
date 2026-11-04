#!/usr/bin/env bash
# Runs ON the VM as root (deploy.sh calls it). Installs Node 22 and Caddy once, unpacks the release,
# writes the systemd unit and Caddyfile, keeps /etc/closer/env (mode 600) across releases.
#   sudo bash /tmp/install_remote.sh DOMAIN SHA
set -euo pipefail
DOMAIN="${1:?domain}"
SHA="${2:?sha}"
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -y && apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
id closer >/dev/null 2>&1 || useradd --system --home /var/lib/closer --shell /usr/sbin/nologin closer
install -d -o closer -g closer -m 750 /var/lib/closer
install -d -m 755 /opt/closer/releases
install -d -m 700 /etc/closer
REL="/opt/closer/releases/$SHA"
rm -rf "$REL" && mkdir -p "$REL"
tar -xzf "/tmp/closer-$SHA.tgz" -C "$REL"
printf '%s\n' "$SHA" > "$REL/BUILD_SHA"
# git archive ships no node_modules: install the pinned runtime dependencies (@meta-sam/parser, three) from the lock file.
(cd "$REL" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chown -R root:root "$REL" && chmod -R a+rX "$REL"
ln -sfn "$REL" /opt/closer/current
if [ ! -f /etc/closer/env ]; then
  umask 077
  # CLOSER_VISITOR_DAY_USD=3 lets a judge trigger live calls from the public sample closets (about 84 photo runs a day at the plan estimates).
  # Set it to 0 outside the judging window. It is $0 from 2026-11-19 00:00 KST whatever the value.
  { echo "CLOSER_MODE=real"; echo "CLOSER_DB_PATH=/var/lib/closer/closer.db"; echo "CLOSER_PORT=8787"; echo "CLOSER_VISITOR_DAY_USD=3"; echo "CLOSER_APP_TOTAL_USD=20"; echo "CLOSER_ADMIN_TOKEN=$(openssl rand -hex 24)"; } > /etc/closer/env
fi
chmod 600 /etc/closer/env
cat > /etc/systemd/system/closer.service <<UNIT
[Unit]
Description=Closer
After=network-online.target
Wants=network-online.target

[Service]
User=closer
WorkingDirectory=/opt/closer/current
EnvironmentFile=/etc/closer/env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning web/server.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/closer

[Install]
WantedBy=multi-user.target
UNIT
# Daily backup (deploy/backup.sh): ledger copy + photos tar into /var/backups/closer, 7 days kept, as the closer user.
install -d -o closer -g closer -m 700 /var/backups/closer
install -m 755 "$REL/deploy/backup.sh" /usr/local/bin/closer-backup
cat > /etc/systemd/system/closer-backup.service <<UNIT
[Unit]
Description=Closer backup (ledger copy + photos tar)

[Service]
Type=oneshot
User=closer
ExecStart=/usr/local/bin/closer-backup /var/lib/closer /var/backups/closer
UNIT
cat > /etc/systemd/system/closer-backup.timer <<UNIT
[Unit]
Description=Daily Closer backup

[Timer]
OnCalendar=*-*-* 04:10:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8787
  header Strict-Transport-Security "max-age=31536000"
}
CADDY
systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy || systemctl restart caddy
systemctl enable closer >/dev/null 2>&1
systemctl enable --now closer-backup.timer >/dev/null 2>&1 || echo "warning: closer-backup.timer not enabled" >&2
if grep -q '^MODEL_API_KEY=.' /etc/closer/env; then
  systemctl restart closer
  echo "closer restarted on release $SHA"
else
  systemctl stop closer 2>/dev/null || true
  echo "release $SHA installed; no MODEL_API_KEY yet → run deploy/gce/push_key.sh (real mode refuses to start without it)"
fi
