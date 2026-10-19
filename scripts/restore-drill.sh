#!/usr/bin/env bash
# Restore drill: proves that a server backup can be restored and that the
# restored data matches what the backup job recorded. Runs on the Docker
# Compose host and never touches the production `bookr` database: the dump is
# imported into a scratch database `bookr_drill_<UTC timestamp>` that is
# dropped afterwards unless --keep is given.
#
# Usage: restore-drill.sh [--dump <file>] [--keep]
#        restore-drill.sh --help
set -Eeuo pipefail
umask 077
# Git Bash on Windows rewrites container paths; harmless on Linux.
export MSYS_NO_PATHCONV=1

COMPOSE_DIR="${COMPOSE_DIR:-/srv/bookr}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/bookr/backups}"
DB_DIR="$BACKUP_ROOT/db"
MINIO_DIR="$BACKUP_ROOT/minio"
DRILL_DIR="$BACKUP_ROOT/drills"

KEEP_DB=0
DUMP_FILE=""

usage() {
  cat <<'EOF'
Restore drill: restores the latest (or --dump) server backup into a scratch
database and verifies it without touching the production `bookr` database.

Usage:
  restore-drill.sh [--dump <file>] [--keep]

Options:
  --dump <file>  Dump to restore. Default: newest $BACKUP_ROOT/db/bookr-*.sql.gz
  --keep         Keep the scratch database after the drill (default: drop it)
  -h, --help     Show this help and exit

Environment:
  COMPOSE_DIR   Compose project directory (default: /srv/bookr)
  BACKUP_ROOT   Backup root (default: /srv/bookr/backups)

Checks:
  - the matching counts-<timestamp>.txt must exist (otherwise the backup is
    incomplete);
  - core table counts restored from the dump must not be lower than the
    recorded counts (extra rows are only noted);
  - the minio/ mirror file count and byte total must match the
    manifest-<timestamp>.txt values exactly.

A PASS/FAIL summary is written to $BACKUP_ROOT/drills/<timestamp>.log.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump)
      if [ "$#" -lt 2 ]; then
        printf 'error: --dump requires a file argument\n' >&2
        exit 2
      fi
      DUMP_FILE="$2"
      shift 2
      ;;
    --keep)
      KEEP_DB=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

DRILL_TS="$(date -u +%Y%m%dT%H%M%SZ)"
# Lowercase UTC stamp keeps the identifier unquoted and obviously scratch-only.
DRILL_DB="bookr_drill_$(printf '%s' "$DRILL_TS" | tr 'A-Z' 'a-z')"
case "$DRILL_DB" in
  bookr_drill_*) ;;
  *)
    printf '[drill] ERROR: refusing unsafe scratch database name: %s\n' "$DRILL_DB" >&2
    exit 1
    ;;
esac

mkdir -p "$DRILL_DIR"
LOG_FILE="$DRILL_DIR/$DRILL_TS.log"
STATUS=PASS
DB_CREATED=0
ACTUAL_COUNTS=""

log() { printf '[drill] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
record() { printf '%s\n' "$*" >>"$LOG_FILE"; printf '%s\n' "$*"; }
note() { record "  $*"; }
fail_check() { STATUS=FAIL; record "FAIL: $*"; }

compose() { docker compose --project-directory "$COMPOSE_DIR" "$@"; }

compare_counts() {
  local table recorded got digits
  for table in users books reading_progress annotations bookmarks \
    reading_sessions daily_stats categories; do
    recorded="$(sed -n "s/^${table}=//p" "$COUNTS_FILE" | head -n 1)"
    got="$(sed -n "s/^${table}=//p" "$ACTUAL_COUNTS" | head -n 1)"
    if [ -z "$recorded" ]; then
      fail_check "counts file is missing '$table'"
      continue
    fi
    if [ -z "$got" ]; then
      fail_check "restored database produced no '$table' count"
      continue
    fi
    digits="$recorded$got"
    if [ -n "${digits//[0-9]/}" ]; then
      fail_check "non-numeric count for $table (recorded=$recorded restored=$got)"
      continue
    fi
    # The dump snapshot predates the counts query, so a restored table can
    # only be equal to or larger than the recorded number. Fewer rows means
    # data loss; more rows are writes that happened after the dump.
    if [ "$got" -lt "$recorded" ]; then
      fail_check "table $table: restored $got < recorded $recorded"
    elif [ "$got" -gt "$recorded" ]; then
      note "table $table: restored $got > recorded $recorded (extra writes after the dump; not a failure)"
    else
      note "table $table: $got"
    fi
  done
}

check_minio() {
  local actual_files actual_bytes recorded_files recorded_bytes
  if [ ! -d "$MINIO_DIR" ]; then
    fail_check "minio mirror is missing: $MINIO_DIR"
    return 0
  fi
  if [ ! -f "$MANIFEST" ]; then
    fail_check "manifest is missing: $MANIFEST"
    return 0
  fi
  recorded_files="$(sed -n 's/^minio_files=//p' "$MANIFEST" | head -n 1)"
  recorded_bytes="$(sed -n 's/^minio_bytes=//p' "$MANIFEST" | head -n 1)"
  if [ -z "$recorded_files" ] || [ -z "$recorded_bytes" ]; then
    fail_check "manifest has no minio_files/minio_bytes entry"
    return 0
  fi
  actual_files="$(find "$MINIO_DIR" -type f | wc -l | tr -d ' ')"
  actual_bytes="$(du -sb "$MINIO_DIR" | cut -f 1)"
  if [ "$actual_files" != "$recorded_files" ]; then
    fail_check "minio_files: mirror=$actual_files manifest=$recorded_files"
  else
    note "minio_files: $actual_files"
  fi
  if [ "$actual_bytes" != "$recorded_bytes" ]; then
    fail_check "minio_bytes: mirror=$actual_bytes manifest=$recorded_bytes"
  else
    note "minio_bytes: $actual_bytes"
  fi
  return 0
}

finish() {
  record "log: $LOG_FILE"
  if [ "$STATUS" = PASS ]; then
    record "RESULT: PASS"
    exit 0
  fi
  record "RESULT: FAIL"
  exit 1
}

cleanup() {
  local rc=$?
  set +e
  trap - EXIT
  if [ "$DB_CREATED" = 1 ]; then
    if [ "$KEEP_DB" = 1 ]; then
      record "scratch database kept: $DRILL_DB"
    elif compose exec -T postgres psql -U bookr -d postgres -q \
      -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE);" >/dev/null 2>&1; then
      record "dropped scratch database $DRILL_DB"
    else
      record "WARN: could not drop scratch database $DRILL_DB; drop it manually"
    fi
  fi
  [ -z "$ACTUAL_COUNTS" ] || rm -f "$ACTUAL_COUNTS"
  exit "$rc"
}

on_error() {
  set +e
  trap - ERR
  # A failure inside a command substitution is reported once by the main
  # shell when the assignment itself fails.
  [ "${BASHPID:-$$}" = "$$" ] || exit 1
  record "ERROR: unexpected failure at line $1"
  STATUS=FAIL
  exit 1
}
trap 'on_error "$LINENO"' ERR
trap cleanup EXIT

record "=== restore drill $DRILL_TS ==="
record "backup root: $BACKUP_ROOT"
log "starting restore drill $DRILL_TS"

if ! command -v docker >/dev/null 2>&1; then
  fail_check "docker is not installed"
  finish
fi
if ! docker compose version >/dev/null 2>&1; then
  fail_check "docker compose is not available"
  finish
fi
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  fail_check "no docker-compose.yml in $COMPOSE_DIR"
  finish
fi
if [ -z "$(compose ps -q postgres 2>/dev/null || true)" ]; then
  fail_check "the postgres service is not running"
  finish
fi

if [ -z "$DUMP_FILE" ]; then
  if [ -d "$DB_DIR" ]; then
    DUMP_FILE="$(ls -1t "$DB_DIR"/bookr-*.sql.gz 2>/dev/null | head -n 1 || true)"
  fi
fi
if [ -z "$DUMP_FILE" ]; then
  fail_check "no dump found under $DB_DIR"
  finish
fi
if [ ! -f "$DUMP_FILE" ]; then
  fail_check "dump not found: $DUMP_FILE"
  finish
fi

DUMP_BASENAME="${DUMP_FILE##*/}"
if [[ "$DUMP_BASENAME" =~ ^bookr-(.+)\.sql\.gz$ ]]; then
  BACKUP_TS="${BASH_REMATCH[1]}"
else
  fail_check "dump name must be bookr-<timestamp>.sql.gz (got $DUMP_BASENAME)"
  finish
fi
COUNTS_FILE="$DB_DIR/counts-$BACKUP_TS.txt"
MANIFEST="$BACKUP_ROOT/manifest-$BACKUP_TS.txt"

record "dump: $DUMP_FILE"
record "timestamp: $BACKUP_TS"
if [ ! -f "$COUNTS_FILE" ]; then
  fail_check "missing $COUNTS_FILE (incomplete backup)"
  finish
fi
record "counts: $COUNTS_FILE"
if [ ! -f "$MANIFEST" ]; then
  fail_check "missing $MANIFEST (incomplete backup)"
fi

if ! compose exec -T postgres psql -U bookr -d postgres -v ON_ERROR_STOP=1 -q \
  -c "CREATE DATABASE \"$DRILL_DB\";"; then
  fail_check "could not create scratch database $DRILL_DB"
  finish
fi
DB_CREATED=1
record "created scratch database $DRILL_DB"

IMPORT_OK=1
record "importing dump (this may take a while)"
if ! gunzip -c "$DUMP_FILE" | compose exec -T postgres psql -U bookr -d "$DRILL_DB" \
  -v ON_ERROR_STOP=1 -q 2>>"$LOG_FILE"; then
  IMPORT_OK=0
  fail_check "dump import failed"
else
  record "import OK"
fi

if [ "$IMPORT_OK" = 1 ]; then
  ACTUAL_COUNTS="$(mktemp)"
  # Keep this query in sync with scripts/backup-export.sh.
  if ! compose exec -T postgres psql -U bookr -d "$DRILL_DB" -At -v ON_ERROR_STOP=1 \
    <<'SQL' >"$ACTUAL_COUNTS" 2>>"$LOG_FILE"
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
  then
    fail_check "could not count core tables in the scratch database"
  else
    record "core table counts:"
    compare_counts
  fi
fi

record "minio mirror:"
check_minio

finish
