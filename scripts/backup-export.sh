#!/usr/bin/env bash
# Server-side nightly backup. Run from cron on the Docker Compose host:
#   15 3 * * * /srv/bookr/scripts/backup-export.sh >> /var/log/bookr-backup.log 2>&1
#
# Produces:
#   $BACKUP_ROOT/db/bookr-<timestamp>.sql.gz   compressed pg_dump (plain SQL)
#   $BACKUP_ROOT/minio/                        mirror of the `bookr` bucket
#   $BACKUP_ROOT/manifest-<timestamp>.txt      sizes for monitoring
# Anything older than BACKUP_KEEP_DAYS is pruned. Any failure exits non-zero.
set -Eeuo pipefail
umask 077
# Git Bash on Windows rewrites container paths such as /backup; harmless on Linux.
export MSYS_NO_PATHCONV=1

COMPOSE_DIR="${COMPOSE_DIR:-/srv/bookr}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/bookr/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
COMPOSE_NETWORK="${COMPOSE_NETWORK:-bookr_default}"
MINIO_HOST="${MINIO_HOST:-minio:9000}"
S3_BUCKET="${S3_BUCKET:-bookr}"
# The MinIO server image bundles `mc`, so the mirror needs no extra image.
MINIO_IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_DIR="$BACKUP_ROOT/db"
MINIO_DIR="$BACKUP_ROOT/minio"

log() { printf '[backup] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }
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
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'manifest-*.txt' -mtime "+$KEEP_DAYS" -delete
find "$DB_DIR" -maxdepth 1 -type f -name '*.partial' -mtime +1 -delete

log "done: $(basename "$DB_FILE") + MinIO mirror"
