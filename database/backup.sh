#!/usr/bin/env bash
#
# My DailyEdge — MySQL backup script.
#
# Dumps the app database to a timestamped gzip file, verifies the dump is
# non-empty, then prunes backups older than RETAIN_DAYS.
#
# Credentials are read from api/config.php at runtime (single source of truth)
# via the php CLI — nothing sensitive is stored in this script. The password is
# passed to mysqldump through the MYSQL_PWD environment variable so it never
# shows up in `ps` output.
#
# --- Setup on cPanel -------------------------------------------------------
#   1. Make sure api/config.php exists and is filled in.
#   2. chmod +x public_html/database/backup.sh
#   3. Add a cron job (cPanel -> Cron Jobs), e.g. daily at 03:30:
#        30 3 * * * /home/<cpanel-user>/public_html/database/backup.sh \
#          >> /home/<cpanel-user>/cron-backup.log 2>&1
#
# --- Restore ---------------------------------------------------------------
#   gunzip < ~/mydailyedge-backups/mydailyedge-YYYY-MM-DD_HHMMSS.sql.gz \
#     | mysql -u <db_user> -p <db_name>
#
# ---------------------------------------------------------------------------

set -euo pipefail

# Days of backups to keep. Older gzip files are deleted after a successful dump.
RETAIN_DAYS=14

# Resolve paths relative to this script so the cron entry can be a bare path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PHP="${SCRIPT_DIR}/../api/config.php"

# Backups live OUTSIDE the web root so they are never served over HTTP.
BACKUP_DIR="${HOME}/mydailyedge-backups"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ ! -f "$CONFIG_PHP" ]; then
  echo "[backup] ERROR: api/config.php not found at $CONFIG_PHP — cannot read DB credentials." >&2
  exit 1
fi

if ! command -v php >/dev/null 2>&1; then
  echo "[backup] ERROR: php CLI not found on PATH." >&2
  exit 1
fi

if ! command -v mysqldump >/dev/null 2>&1; then
  echo "[backup] ERROR: mysqldump not found on PATH." >&2
  exit 1
fi

# Pull DB settings out of config.php. The php snippet prints one value; a
# missing key yields an empty string, which we validate below.
read_config() {
  php -r '$c = require $argv[1]; echo isset($c[$argv[2]]) ? (string) $c[$argv[2]] : "";' "$CONFIG_PHP" "$1"
}

DB_HOST="$(read_config db_host)"
DB_NAME="$(read_config db_name)"
DB_USER="$(read_config db_user)"
DB_PASS="$(read_config db_pass)"
DB_HOST="${DB_HOST:-localhost}"

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  echo "[backup] ERROR: db_name or db_user missing from config.php." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

STAMP="$(date '+%Y-%m-%d_%H%M%S')"
BACKUP_FILE="${BACKUP_DIR}/mydailyedge-${STAMP}.sql.gz"

log "dumping database '${DB_NAME}' as '${DB_USER}' -> ${BACKUP_FILE}"

# --single-transaction: consistent snapshot of InnoDB tables without locking.
# --quick: stream rows instead of buffering the whole result set in memory.
# MYSQL_PWD keeps the password out of the process list.
export MYSQL_PWD="$DB_PASS"
set +e
mysqldump \
  --single-transaction \
  --quick \
  --default-character-set=utf8mb4 \
  --no-tablespaces \
  -h "$DB_HOST" \
  -u "$DB_USER" \
  "$DB_NAME" \
  | gzip > "$BACKUP_FILE"
DUMP_STATUS="${PIPESTATUS[0]}"
set -e
unset MYSQL_PWD

if [ "$DUMP_STATUS" -ne 0 ]; then
  echo "[backup] ERROR: mysqldump exited with status ${DUMP_STATUS}. Leaving older backups intact." >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

if [ ! -s "$BACKUP_FILE" ]; then
  echo "[backup] ERROR: dump file is empty. Leaving older backups intact." >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

chmod 600 "$BACKUP_FILE" 2>/dev/null || true
SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
log "dump complete (${SIZE})"

# Prune old backups only after a confirmed-good dump.
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'mydailyedge-*.sql.gz' -type f -mtime "+${RETAIN_DAYS}" -print -delete | wc -l | tr -d ' ')"
log "pruned ${DELETED} backup(s) older than ${RETAIN_DAYS} day(s)"

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'mydailyedge-*.sql.gz' -type f | wc -l | tr -d ' ')"
log "done. ${REMAINING} backup(s) on disk in ${BACKUP_DIR}"
