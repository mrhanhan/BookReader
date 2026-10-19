#!/usr/bin/env bash
# Server-side nightly backup. Run from cron on the Docker Compose host:
#   15 3 * * * /srv/bookr/scripts/backup-export.sh >> /var/log/bookr-backup.log 2>&1
#
# Produces:
#   $BACKUP_ROOT/db/bookr-<timestamp>.sql.gz   compressed pg_dump (plain SQL)
#   $BACKUP_ROOT/db/counts-<timestamp>.txt     core table row counts for drills
#   $BACKUP_ROOT/minio/                        mirror of the `bookr` bucket
#   $BACKUP_ROOT/manifest-<timestamp>.txt      sizes for monitoring
# Anything older than BACKUP_KEEP_DAYS is pruned. Any failure exits non-zero.
# If BOOKR_BACKUP_TOKEN is set, success/failure heartbeats are reported to the
# server; a failed report only logs a warning and never changes the exit code.
set -Eeuo pipefail
umask 077
# Git Bash on Windows rewrites container paths such as /backup; harmless on Linux.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/heartbeat.sh
. "$SCRIPT_DIR/lib/heartbeat.sh"

COMPOSE_DIR="${COMPOSE_DIR:-/srv/bookr}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/bookr/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
COMPOSE_NETWORK="${COMPOSE_NETWORK:-bookr_default}"
MINIO_HOST="${MINIO_HOST:-minio:9000}"
S3_BUCKET="${S3_BUCKET:-bookr}"
# The MinIO server image bundles `mc`, so the mirror needs no extra image.
MINIO_IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z}"

STARTED_ISO="$(date -u +%FT%TZ)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_DIR="$BACKUP_ROOT/db"
MINIO_DIR="$BACKUP_ROOT/minio"

log() { printf '[backup] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Reports failure before exiting. ERR is cleared first so a failure inside the
# heartbeat (or the trap itself) cannot recurse; the heartbeat always returns 0
# so the explicit exit status below is the one the scheduler sees.
report_failure() {
  set +e
  trap - ERR
  # Only the main shell reports; a failing command substitution would
  # otherwise send a second heartbeat from its subshell.
  [ "${BASHPID:-$$}" = "$$" ] || return 0
  local now
  now="$(date -u +%FT%TZ)"
  heartbeat_report server-export failure "$STARTED_ISO" "$now" "" "$1" "$BACKUP_ROOT"
  return 0
}

fail() {
  printf '[backup] ERROR: %s\n' "$*" >&2
  report_failure "$*"
  exit 1
}
trap 'fail "aborted at line $LINENO"' ERR

compose() { docker compose --project-directory "$COMPOSE_DIR" "$@"; }

# Reads an environment variable baked into a running compose container.
container_env() {
  local service="$1" name="$2" id
  id="$(compose ps -q "$service")"
  [ -n "$id" ] || fail "service '$service' is not running"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" \
    | sed -n "s/^${name}=//p" | head -n 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose is not available"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || fail "no docker-compose.yml in $COMPOSE_DIR"

mkdir -p "$DB_DIR" "$MINIO_DIR"

# --- Postgres dump ----------------------------------------------------------
DB_FILE="$DB_DIR/bookr-$TIMESTAMP.sql.gz"
TMP_DB="$DB_FILE.partial"
log "dumping postgres to $DB_FILE"
compose exec -T postgres pg_dump -U bookr -d bookr --no-owner --no-privileges \
  | gzip -9 >"$TMP_DB"
gzip -t "$TMP_DB"
mv "$TMP_DB" "$DB_FILE"

# --- Core table counts -------------------------------------------------------
# Written right after the dump so restore-drill.sh can prove that a restored
# dump contains every row the backup job saw. Keep this query in sync with the
# copy in restore-drill.sh.
COUNTS_FILE="$DB_DIR/counts-$TIMESTAMP.txt"
TMP_COUNTS="$COUNTS_FILE.partial"
log "counting core tables to $COUNTS_FILE"
compose exec -T postgres psql -U bookr -d bookr -At -v ON_ERROR_STOP=1 <<'SQL' >"$TMP_COUNTS"
SELECT label || '=' || n
FROM (
  SELECT 'users' AS label, 1 AS ord, count(*) AS n FROM users
  UNION ALL SELECT 'books', 2, count(*) FROM books WHERE deleted_at IS NULL
  UNION ALL SELECT 'reading_progress', 3, count(*) FROM reading_progress
  UNION ALL SELECT 'annotations', 4, count(*) FROM annotations WHERE deleted_at IS NULL
  UNION ALL SELECT 'bookmarks', 5, count(*) FROM bookmarks WHERE deleted_at IS NULL
  UNION ALL SELECT 'reading_sessions', 6, count(*) FROM reading_sessions
  UNION ALL SELECT 'daily_stats', 7, count(*) FROM daily_stats
  UNION ALL SELECT 'categories', 8, count(*) FROM categories
) AS core
ORDER BY ord;
SQL
mv "$TMP_COUNTS" "$COUNTS_FILE"

# --- MinIO mirror -----------------------------------------------------------
# Credentials are read from the running MinIO container so they do not have
# to be duplicated in the host environment.
S3_ACCESS_KEY="${S3_ACCESS_KEY:-$(container_env minio MINIO_ROOT_USER)}"
S3_SECRET_KEY="${S3_SECRET_KEY:-$(container_env minio MINIO_ROOT_PASSWORD)}"
[ -n "$S3_ACCESS_KEY" ] && [ -n "$S3_SECRET_KEY" ] || fail "MinIO credentials were not found"

log "mirroring bucket '$S3_BUCKET' to $MINIO_DIR"
# Deliberately no --remove: mirroring deletions would erase the only
# server-side copy when the bucket is wiped by mistake. Objects removed from
# the bucket simply disappear from future restic snapshots' delta.
docker run --rm \
  --network "$COMPOSE_NETWORK" \
  --env "MC_HOST_local=http://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@${MINIO_HOST}" \
  --volume "$MINIO_DIR:/backup" \
  --entrypoint mc \
  "$MINIO_IMAGE" \
  mirror --overwrite "local/$S3_BUCKET" /backup

# --- Manifest ---------------------------------------------------------------
MANIFEST="$BACKUP_ROOT/manifest-$TIMESTAMP.txt"
{
  echo "timestamp=$TIMESTAMP"
  echo "host=$(hostname)"
  echo "db_file=$(basename "$DB_FILE")"
  echo "db_bytes=$(stat -c %s "$DB_FILE")"
  echo "db_sha256=$(sha256sum "$DB_FILE" | cut -d ' ' -f 1)"
  echo "minio_bucket=$S3_BUCKET"
  echo "minio_files=$(find "$MINIO_DIR" -type f | wc -l | tr -d ' ')"
  echo "minio_bytes=$(du -sb "$MINIO_DIR" | cut -f 1)"
} >"$MANIFEST"
ln -sfn "$(basename "$MANIFEST")" "$BACKUP_ROOT/manifest.txt"

# --- Retention --------------------------------------------------------------
find "$DB_DIR" -maxdepth 1 -type f -name 'bookr-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$DB_DIR" -maxdepth 1 -type f -name 'counts-*.txt' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'manifest-*.txt' -mtime "+$KEEP_DAYS" -delete
find "$DB_DIR" -maxdepth 1 -type f -name '*.partial' -mtime +1 -delete

# --- Heartbeat --------------------------------------------------------------
MINIO_BYTES="$(sed -n 's/^minio_bytes=//p' "$MANIFEST" | head -n 1)"
MINIO_FILES="$(sed -n 's/^minio_files=//p' "$MANIFEST" | head -n 1)"
FINISHED_ISO="$(date -u +%FT%TZ)"
heartbeat_report server-export success "$STARTED_ISO" "$FINISHED_ISO" \
  "$MINIO_BYTES" "dump $(basename "$DB_FILE"), counts $(basename "$COUNTS_FILE"), minio files=$MINIO_FILES" \
  "$BACKUP_ROOT" || true

log "done: $(basename "$DB_FILE") + $(basename "$COUNTS_FILE") + MinIO mirror"
