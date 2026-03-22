#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Khedmah — Production Server Setup
# ══════════════════════════════════════════════════════════════════════════════
# Run once on a fresh Ubuntu 22.04 LTS server as root (or with sudo).
#
# What it does:
#   1. System hardening (fail2ban, ufw firewall, unattended upgrades)
#   2. Docker + Docker Compose v2 install
#   3. AWS CLI v2 install (for S3 backups)
#   4. Creates /opt/khedmah deployment directory with correct permissions
#   5. Creates khedmah system user (non-root, docker group)
#   6. Sets up automated daily DB backup cron job
#   7. Sets up log rotation for Docker containers
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Mo00502/khedmah-backend/main/scripts/setup-server.sh | sudo bash
#
# After running:
#   1. Copy .env.production to /opt/khedmah/.env
#   2. Copy docker-compose.yml to /opt/khedmah/docker-compose.yml
#   3. Copy docker/ directory to /opt/khedmah/docker/
#   4. Run: cd /opt/khedmah && docker compose up -d
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo -e "\n\033[1;32m▶ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠  $*\033[0m"; }
die()  { echo -e "\033[1;31m✗  $*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "This script must be run as root. Use: sudo bash setup-server.sh"

DEPLOY_DIR="/opt/khedmah"
KHEDMAH_USER="khedmah"
DOCKER_COMPOSE_VERSION="2.27.0"

# ══════════════════════════════════════════════════════════════════════════════
# 1. System update
# ══════════════════════════════════════════════════════════════════════════════
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git unzip gnupg ca-certificates lsb-release \
  fail2ban ufw \
  logrotate \
  jq \
  awscli

# ══════════════════════════════════════════════════════════════════════════════
# 2. Unattended security upgrades
# ══════════════════════════════════════════════════════════════════════════════
log "Enabling unattended-upgrades for security patches..."
apt-get install -y -qq unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# ══════════════════════════════════════════════════════════════════════════════
# 3. Firewall (ufw)
# ══════════════════════════════════════════════════════════════════════════════
log "Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment "SSH"
ufw allow 80/tcp   comment "HTTP (redirect to HTTPS)"
ufw allow 443/tcp  comment "HTTPS"
ufw --force enable
ufw status verbose

# ══════════════════════════════════════════════════════════════════════════════
# 4. fail2ban
# ══════════════════════════════════════════════════════════════════════════════
log "Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
EOF
systemctl enable fail2ban
systemctl restart fail2ban

# ══════════════════════════════════════════════════════════════════════════════
# 5. Docker
# ══════════════════════════════════════════════════════════════════════════════
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "Docker installed: $(docker --version)"
else
  echo "Docker already installed: $(docker --version)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 6. khedmah system user
# ══════════════════════════════════════════════════════════════════════════════
log "Creating khedmah system user..."
if ! id "$KHEDMAH_USER" &>/dev/null; then
  useradd --system --create-home --shell /bin/bash "$KHEDMAH_USER"
fi
usermod -aG docker "$KHEDMAH_USER"

# ══════════════════════════════════════════════════════════════════════════════
# 7. Deployment directory
# ══════════════════════════════════════════════════════════════════════════════
log "Creating deployment directory: ${DEPLOY_DIR}"
mkdir -p "${DEPLOY_DIR}/docker/ssl"
chown -R "${KHEDMAH_USER}:${KHEDMAH_USER}" "${DEPLOY_DIR}"
chmod 750 "${DEPLOY_DIR}"

# ══════════════════════════════════════════════════════════════════════════════
# 8. Log rotation for Docker
# ══════════════════════════════════════════════════════════════════════════════
log "Configuring Docker log rotation..."
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
EOF
systemctl restart docker

# ══════════════════════════════════════════════════════════════════════════════
# 9. Automated daily DB backup cron (runs at 02:00 server time)
# ══════════════════════════════════════════════════════════════════════════════
log "Installing daily backup cron job..."
CRON_SCRIPT="/usr/local/bin/khedmah-backup"
cat > "$CRON_SCRIPT" <<'CRONEOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/khedmah
# Load env vars
set -o allexport; source .env; set +o allexport
# Run pg_dump inside the postgres container, upload to S3
docker compose exec -T postgres pg_dump \
  -U "$DB_USER" -d "$DB_NAME" --no-password --format=plain --no-owner --no-acl \
  | gzip -9 > /tmp/khedmah_$(date +%Y%m%d_%H%M%S).sql.gz

# Upload to S3
DUMP=/tmp/khedmah_$(date +%Y%m%d).sql.gz
[[ -f "$DUMP" ]] || DUMP=$(ls -t /tmp/khedmah_*.sql.gz 2>/dev/null | head -1)
if [[ -n "$DUMP" && -f "$DUMP" ]]; then
  AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    aws s3 cp "$DUMP" "s3://${BACKUP_S3_BUCKET:-$S3_BUCKET}/db/$(basename $DUMP)" \
    ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} --sse AES256 --storage-class STANDARD_IA
  rm -f "$DUMP"
fi
# Prune local dumps older than 7 days
find /tmp -name "khedmah_*.sql.gz" -mtime +7 -delete
CRONEOF
chmod +x "$CRON_SCRIPT"

(crontab -l -u "$KHEDMAH_USER" 2>/dev/null; echo "0 2 * * * $CRON_SCRIPT >> /var/log/khedmah-backup.log 2>&1") \
  | crontab -u "$KHEDMAH_USER" -

# ══════════════════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════════════════
log "✅ Server setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy .env.production  → ${DEPLOY_DIR}/.env"
echo "  2. Copy docker-compose.yml and docker/ → ${DEPLOY_DIR}/"
echo "  3. Add SSL certs to ${DEPLOY_DIR}/docker/ssl/ (fullchain.pem + privkey.pem)"
echo "     Or use: certbot certonly --standalone -d api.khedmah.sa"
echo "  4. su - khedmah"
echo "     cd ${DEPLOY_DIR}"
echo "     docker compose --profile production up -d"
echo "     docker compose --profile migrate run --rm migrate"
echo ""
echo "GitHub Secrets needed for CI/CD auto-deploy:"
echo "  DEPLOY_HOST      = $(hostname -I | awk '{print $1}')"
echo "  DEPLOY_USER      = khedmah"
echo "  DEPLOY_SSH_KEY   = (add khedmah user's SSH private key)"
echo "  SLACK_WEBHOOK_URL = (optional — for deploy failure alerts)"
