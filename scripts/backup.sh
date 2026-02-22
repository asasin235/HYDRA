#!/usr/bin/env bash
set -euo pipefail

# Configuration from environment
: "${B2_ACCOUNT_ID:?Missing B2_ACCOUNT_ID}"
: "${B2_APP_KEY:?Missing B2_APP_KEY}"
: "${B2_BUCKET:?Missing B2_BUCKET}"
: "${RCLONE_CRYPT_PASSWORD:?Missing RCLONE_CRYPT_PASSWORD}"
: "${SLACK_BOT_TOKEN:=}"
: "${SLACK_STATUS_CHANNEL:=#hydra-status}"

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
  rclone config create hydra-backup b2 \
    account "$B2_ACCOUNT_ID" key "$B2_APP_KEY" >/dev/null 2>&1 || true

  # Configure crypt remote layered on top
  rclone config create hydra-backup-crypt crypt \
    remote hydra-backup:"$B2_BUCKET" password "$RCLONE_CRYPT_PASSWORD" >/dev/null 2>&1 || true
}

run_sync() {
  local start_ts=$(date +%s)
  # Excludes: audio_inbox/, screenpipe raw captures >7 days already cleaned; enforce audio_inbox explicitly
  rclone sync "$BRAIN_DIR/" hydra-backup-crypt:/ \
    --exclude "audio_inbox/**" \
    --transfers 4 \
    --log-file "$LOG_FILE" \
    --verbose

  local end_ts=$(date +%s)
  local dur=$((end_ts - start_ts))
  local size=$(rclone size hydra-backup-crypt:/ --json | jq -r '.bytes // 0' 2>/dev/null || echo 0)
  local size_gb=$(awk -v b="$size" 'BEGIN { printf "%.2f", b/1024/1024/1024 }')
  post_slack "✅ Backup complete ${size_gb}GB in ${dur}s"
}

main() {
  ensure_rclone
  configure_rclone
  run_sync
}

main "$@"
