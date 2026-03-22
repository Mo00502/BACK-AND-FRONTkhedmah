#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Khedmah — PostgreSQL Backup Script
# ══════════════════════════════════════════════════════════════════════════════
# Usage:
#   ./docker/backup.sh               # dump + upload to S3
#   ./docker/backup.sh --local-only  # dump to /backups, skip S3 upload
#   ./docker/backup.sh --restore <file>  # restore from a .sql.gz file
#
# Required env vars (loaded from .env or shell):
#   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
#   S3_ENDPOINT, S3_BUCKET, BACKUP_S3_BUCKET (or S3_BUCKET), BACKUP_S3_PREFIX
#   S3_ACCESS_KEY, S3_SECRET_KEY
#
# Dependencies: pg_dump, pg_restore, aws CLI (for S3 upload), gzip
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/tmp/khedmah-backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-khedmah_prod}"
DB_USER="${DB_USER:-khedmah}"
BACKUP_BUCKET="${BACKUP_S3_BUCKET:-${S3_BUCKET:-}}"
BACKUP_PREFIX="${BACKUP_S3_PREFIX:-db}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

DUMP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

# ── Parse args ────────────────────────────────────────────────────────────────
LOCAL_ONLY=false
RESTORE_FILE=""
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=true ;;
    --restore)    RESTORE_MODE=true ;;
    *)            [[ "${RESTORE_MODE:-false}" == true ]] && RESTORE_FILE="$arg" && RESTORE_MODE=false ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }
die()  { err "$*"; exit 1; }

require_cmd() { command -v "$1" &>/dev/null || die "Required command not found: $1"; }

# ── Restore mode ──────────────────────────────────────────────────────────────
if [[ -n "$RESTORE_FILE" ]]; then
  require_cmd psql
  [[ -f "$RESTORE_FILE" ]] || die "Restore file not found: $RESTORE_FILE"
  log "🔄 Restoring from: $RESTORE_FILE"
  export PGPASSWORD="$DB_PASSWORD"
  gunzip -c "$RESTORE_FILE" | psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"
  log "✅ Restore complete."
  exit 0
fi

# ── Backup mode ───────────────────────────────────────────────────────────────
require_cmd pg_dump
require_cmd gzip

log "🗄  Starting backup: ${DB_NAME} → ${DUMP_FILE}"
mkdir -p "$BACKUP_DIR"

# Dump and compress in one pipe
export PGPASSWORD="${DB_PASSWORD:-}"
pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-password \
  --format=plain \
  --no-owner \
  --no-acl \
  | gzip -9 > "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
log "✅ Dump complete — size: ${DUMP_SIZE}"

# ── S3 upload ─────────────────────────────────────────────────────────────────
if [[ "$LOCAL_ONLY" == false ]]; then
  require_cmd aws

  [[ -n "$BACKUP_BUCKET" ]] || die "BACKUP_S3_BUCKET / S3_BUCKET not set"

  S3_KEY="${BACKUP_PREFIX}/${DB_NAME}_${TIMESTAMP}.sql.gz"
  S3_URI="s3://${BACKUP_BUCKET}/${S3_KEY}"

  log "⬆  Uploading to ${S3_URI} ..."

  AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
  AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}" \
  aws s3 cp "$DUMP_FILE" "$S3_URI" \
    ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} \
    --sse AES256 \
    --storage-class STANDARD_IA \
    --metadata "db=${DB_NAME},timestamp=${TIMESTAMP}"

  log "✅ Upload complete: ${S3_URI}"

  # ── Prune old local files ────────────────────────────────────────────────
  find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
  log "🧹 Pruned local backups older than ${RETENTION_DAYS} days"
fi

log "🎉 Backup finished: ${DUMP_FILE}"
echo "$DUMP_FILE"
