#!/usr/bin/env bash
# Shared backup heartbeat reporter, sourced by backup-export.sh and
# pull-backup.sh.
#
#   heartbeat_report <source> <status> <started_iso> <finished_iso> \
#                    [bytes] [message] [disk_dir]
#
# Posts a payload matching the shared `backupHeartbeatSchema` contract to
# POST /api/admin/backup/heartbeat. Reporting is strictly best-effort: every
# failure path logs a warning and returns 0, so it can never change the
# outcome of the backup that called it. Set BACKUP_HEARTBEAT_DRY_RUN=1 to
# print the JSON instead of sending it.
#
# Environment:
#   BOOKR_HEARTBEAT_URL   full endpoint override
#   BOOKR_API_URL         server base URL (default http://127.0.0.1:8180)
#   BOOKR_BACKUP_TOKEN    value for the X-Backup-Token header; when unset the
#                         report is skipped with a warning (no 401 spam)

_heartbeat_warn() {
  if declare -F log >/dev/null 2>&1; then
    log "WARN: heartbeat: $*" >&2
  else
    printf '[heartbeat] WARN: %s\n' "$*" >&2
  fi
}

_heartbeat_json_escape() {
  local value="$1"
  # JSON escapes a backslash as `\\`, so it must be replaced before the quote
  # and whitespace escapes that introduce new backslashes (Windows paths in
  # messages would otherwise turn `\n` into a line break).
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  # Control characters without a short JSON escape stay invalid; replace the
  # rest so the payload always parses.
  value="${value//[[:cntrl:]]/ }"
  printf '%s' "$value"
}

_heartbeat_is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# backup-export.sh exports MSYS_NO_PATHCONV=1 so container paths reach Docker
# unchanged, which also stops Git Bash from translating /dev/null into the
# Windows device. Windows curl then fails to open the output path (exit 23)
# *after* the request has been sent, so a delivered report is reported as
# failed and the warning hides the real cause. Pick the platform null device
# explicitly. Cygwin is deliberately absent: its curl is a Cygwin binary where
# /dev/null already works and "nul" would be an ordinary file name.
_heartbeat_null_device() {
  case "$(uname -s 2>/dev/null || printf unknown)" in
    MINGW* | MSYS*) printf nul ;;
    *) printf /dev/null ;;
  esac
}

heartbeat_report() {
  local source="${1-}" status="${2-}" started="${3-}" finished="${4-}"
  local bytes_arg="${5-}" message="${6-}" disk_dir="${7-}"
  local base url http_code payload
  local disk_blocks="" disk_available=""

  case "$source" in
    server-export | backup-pc) ;;
    *)
      _heartbeat_warn "unknown source '$source'; not reporting"
      return 0
      ;;
  esac
  case "$status" in
    success | failure) ;;
    *)
      _heartbeat_warn "unknown status '$status'; not reporting"
      return 0
      ;;
  esac
  if [ -z "$started" ] || [ -z "$finished" ]; then
    _heartbeat_warn "startedAt/finishedAt are required; not reporting"
    return 0
  fi

  # POSIX `df -Pk` output: Filesystem 1024-blocks Used Available Capacity Mounted.
  # The last line holds the numbers even when a long device name wraps.
  if [ -n "$disk_dir" ] && [ -d "$disk_dir" ] && command -v df >/dev/null 2>&1; then
    if read -r disk_blocks disk_available < <(df -Pk "$disk_dir" 2>/dev/null | awk 'END { print $2, $4 }'); then
      if ! _heartbeat_is_uint "$disk_blocks" || ! _heartbeat_is_uint "$disk_available"; then
        disk_blocks=""
        disk_available=""
      fi
    fi
  fi

  payload="{\"source\":\"$(_heartbeat_json_escape "$source")\""
  payload+=",\"status\":\"$(_heartbeat_json_escape "$status")\""
  payload+=",\"startedAt\":\"$(_heartbeat_json_escape "$started")\""
  payload+=",\"finishedAt\":\"$(_heartbeat_json_escape "$finished")\""
  if _heartbeat_is_uint "$bytes_arg"; then
    # 10# keeps values with a leading zero from being read as octal.
    payload+=",\"bytes\":$((10#$bytes_arg))"
  fi
  if [ -n "$disk_blocks" ] && [ -n "$disk_available" ]; then
    payload+=",\"diskFreeBytes\":$((10#$disk_available * 1024))"
    payload+=",\"diskTotalBytes\":$((10#$disk_blocks * 1024))"
  fi
  if [ -n "$message" ]; then
    message="${message//$'\n'/ }"
    message="${message//$'\r'/ }"
    # The server schema rejects messages longer than 1000 characters.
    message="${message:0:1000}"
    payload+=",\"message\":\"$(_heartbeat_json_escape "$message")\""
  fi
  payload+="}"

  if [ "${BACKUP_HEARTBEAT_DRY_RUN:-}" = "1" ]; then
    printf '%s\n' "$payload"
    return 0
  fi

  # Without a shared token the server answers 401 for script reports; skip
  # the request entirely. The server-side backupStale monitor still notices
  # that the source has gone silent.
  if [ -z "${BOOKR_BACKUP_TOKEN:-}" ]; then
    _heartbeat_warn "未配置 token（BOOKR_BACKUP_TOKEN），跳过心跳上报"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    _heartbeat_warn "curl is not installed; heartbeat not sent"
    return 0
  fi

  if [ -n "${BOOKR_HEARTBEAT_URL:-}" ]; then
    url="$BOOKR_HEARTBEAT_URL"
  else
    base="${BOOKR_API_URL:-http://127.0.0.1:8180}"
    url="${base%/}/api/admin/backup/heartbeat"
  fi

  local -a curl_args=(
    curl -sS --max-time 15 -o "$(_heartbeat_null_device)" -w '%{http_code}'
    -X POST -H 'Content-Type: application/json'
    -H "X-Backup-Token: ${BOOKR_BACKUP_TOKEN}"
  )
  curl_args+=(--data-binary "$payload" "$url")

  local curl_exit=0
  http_code="$("${curl_args[@]}" 2>/dev/null)" || curl_exit=$?
  if [ "$curl_exit" -ne 0 ]; then
    _heartbeat_warn "POST $url failed (curl exit $curl_exit); backup result unchanged"
    return 0
  fi
  case "$http_code" in
    2??) ;;
    *) _heartbeat_warn "POST $url returned HTTP $http_code; backup result unchanged" ;;
  esac
  return 0
}
