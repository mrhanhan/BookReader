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
#
# Any failure exits non-zero so the scheduler/monitoring can alert.
set -Eeuo pipefail
umask 077

SOURCE="${BOOKR_BACKUP_SOURCE:?set BOOKR_BACKUP_SOURCE to user@host:/srv/bookr/backups}"
DEST="${BOOKR_BACKUP_DEST:-$HOME/bookr-backups}"
KEEP_DAILY="${RESTIC_KEEP_DAILY:-30}"

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY to the restic repository location}"
export RESTIC_REPOSITORY
if [ -z "${RESTIC_PASSWORD_FILE:-}" ] && [ -z "${RESTIC_PASSWORD:-}" ]; then
  echo "[pull-backup] ERROR: set RESTIC_PASSWORD_FILE or RESTIC_PASSWORD" >&2
  exit 1
fi

log() { printf '[pull-backup] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '[pull-backup] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "aborted at line $LINENO"' ERR

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

log "done"
