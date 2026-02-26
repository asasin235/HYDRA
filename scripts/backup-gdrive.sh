#!/usr/bin/env bash
set -euo pipefail

# Configuration from environment
: "${GOOGLE_SERVICE_ACCOUNT_PATH:?Missing GOOGLE_SERVICE_ACCOUNT_PATH}"
: "${GOOGLE_DRIVE_FOLDER_ID:?Missing GOOGLE_DRIVE_FOLDER_ID}"
# Optional: Set RCLONE_CRYPT_PASSWORD for encrypted backups
RCLONE_CRYPT_PASSWORD="${RCLONE_CRYPT_PASSWORD:-}"
: "${SLACK_BOT_TOKEN:=}"
: "${SLACK_STATUS_CHANNEL:=#00-architect}"

BRAIN_PATH="${BRAIN_PATH:-./brain}"
BRAIN_DIR="$BRAIN_PATH/brain"
LOGS_DIR="${HYDRA_LOGS_DIR:-./logs}"
LOG_FILE="$LOGS_DIR/backup.log"

mkdir -p "$LOGS_DIR"

post_slack() {
  local msg="$1"
  if [[ -n "$SLACK_BOT_TOKEN" ]]; then
    curl -s -X POST https://slack.com/api/chat.postMessage \
      -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$SLACK_STATUS_CHANNEL\",\"text\":\"$msg\"}" >/dev/null || true
  fi
}

ensure_rclone() {
  if ! command -v rclone >/dev/null 2>&1; then
    echo "rclone not found; attempting to install..." | tee -a "$LOG_FILE"
    curl -fsSL https://rclone.org/install.sh | bash
  fi
}

configure_rclone() {
  # Configure standard remote
  rclone config create hydra-gdrive drive \
    service_account_file "$GOOGLE_SERVICE_ACCOUNT_PATH" \
    root_folder_id "$GOOGLE_DRIVE_FOLDER_ID" >/dev/null 2>&1 || true

  # Configure crypt remote layered on top if password is provided
  if [[ -n "$RCLONE_CRYPT_PASSWORD" ]]; then
    rclone config create hydra-backup-crypt crypt \
      remote hydra-gdrive:/ password "$RCLONE_CRYPT_PASSWORD" >/dev/null 2>&1 || true
    DEST_REMOTE="hydra-backup-crypt:/"
  else
    DEST_REMOTE="hydra-gdrive:/"
  fi
}

run_sync() {
  local start_ts=$(date +%s)
  # Excludes: audio_inbox/
  rclone sync "$BRAIN_DIR/" "$DEST_REMOTE" \
    --exclude "audio_inbox/**" \
    --transfers 4 \
    --log-file "$LOG_FILE" \
    --verbose || {
      post_slack "🚨 GDrive Backup failed. Check logs."
      exit 1
    }

  local end_ts=$(date +%s)
  local dur=$((end_ts - start_ts))
  local size=$(rclone size "$DEST_REMOTE" --json | jq -r '.bytes // 0' 2>/dev/null || echo 0)
  local size_gb=$(awk -v b="$size" 'BEGIN { printf "%.2f", b/1024/1024/1024 }')
  post_slack "✅ GDrive Backup complete ${size_gb}GB in ${dur}s"
}

main() {
  ensure_rclone
  configure_rclone
  run_sync
}

main "$@"
