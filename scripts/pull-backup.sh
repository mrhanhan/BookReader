#!/usr/bin/env bash
# Pulls the server backup directory onto the 5080 backup PC and snapshots it
# with restic. Designed for WSL (cron) or Windows Task Scheduler:
#   wsl.exe -e bash -lc '~/bin/pull-backup.sh'
#
# Required environment:
#   BOOKR_BACKUP_SOURCE  rsync source, e.g. bookr@server.example:/srv/bookr/backups
#   RESTIC_REPOSITORY    restic repository (sftp:, s3:, local path, ...)
#   RESTIC_PASSWORD_FILE or RESTIC_PASSWORD
# Optional:
#   BOOKR_BACKUP_DEST    local mirror (default: ~/bookr-backups)
#   BOOKR_SSH            rsync -e value (default: ssh)
#   RESTIC_KEEP_DAILY    daily snapshots to keep (default: 30)
#   BOOKR_BACKUP_TOKEN   sends X-Backup-Token with the heartbeat report
#   BOOKR_API_URL        server base URL for heartbeats (default 127.0.0.1:8180)
#
# Any failure exits non-zero so the scheduler/monitoring can alert. Heartbeats
# are best-effort and never change that exit code.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/heartbeat.sh
. "$SCRIPT_DIR/lib/heartbeat.sh"

STARTED_ISO="$(date -u +%FT%TZ)"
DEST="${BOOKR_BACKUP_DEST:-$HOME/bookr-backups}"
KEEP_DAILY="${RESTIC_KEEP_DAILY:-30}"

log() { printf '[pull-backup] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# See backup-export.sh: clear ERR first so a failed heartbeat cannot recurse,
# and keep the explicit exit status. DEST may not exist yet on early failures.
report_failure() {
  set +e
  trap - ERR
  # Only the main shell reports; a failing command substitution would
  # otherwise send a second heartbeat from its subshell.
  [ "${BASHPID:-$$}" = "$$" ] || return 0
  local now
  now="$(date -u +%FT%TZ)"
  heartbeat_report backup-pc failure "$STARTED_ISO" "$now" "" "$1" "$DEST"
  return 0
}

fail() {
  printf '[pull-backup] ERROR: %s\n' "$*" >&2
  report_failure "$*"
  exit 1
}
trap 'fail "aborted at line $LINENO"' ERR

SOURCE="${BOOKR_BACKUP_SOURCE:-}"
[ -n "$SOURCE" ] || fail "set BOOKR_BACKUP_SOURCE to user@host:/srv/bookr/backups"

RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-}"
[ -n "$RESTIC_REPOSITORY" ] || fail "set RESTIC_REPOSITORY to the restic repository location"
export RESTIC_REPOSITORY
if [ -z "${RESTIC_PASSWORD_FILE:-}" ] && [ -z "${RESTIC_PASSWORD:-}" ]; then
  fail "set RESTIC_PASSWORD_FILE or RESTIC_PASSWORD"
fi

command -v rsync >/dev/null 2>&1 || fail "rsync is not installed"
command -v restic >/dev/null 2>&1 || fail "restic is not installed"

mkdir -p "$DEST"

# --delete-after removes files the server has already pruned, while keeping
# the previous local copy intact until the transfer itself succeeds.
log "rsyncing ${SOURCE%/}/ -> ${DEST%/}/"
rsync -az --delete-after -e "${BOOKR_SSH:-ssh}" "${SOURCE%/}/" "${DEST%/}/"

log "snapshotting $DEST with restic"
restic backup --tag bookr "$DEST"

log "pruning snapshots older than $KEEP_DAILY daily snapshots"
restic forget --tag bookr --keep-daily "$KEEP_DAILY" --prune

# --- Heartbeat --------------------------------------------------------------
DEST_BYTES="$(du -sb "$DEST" | cut -f 1)"
heartbeat_report backup-pc success "$STARTED_ISO" "$(date -u +%FT%TZ)" \
  "$DEST_BYTES" "rsync + restic snapshot complete" "$DEST" || true

log "done"
