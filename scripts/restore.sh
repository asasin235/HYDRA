#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_SERVICE_ACCOUNT_PATH:?Missing GOOGLE_SERVICE_ACCOUNT_PATH}"
: "${GOOGLE_DRIVE_FOLDER_ID:?Missing GOOGLE_DRIVE_FOLDER_ID}"
RCLONE_CRYPT_PASSWORD="${RCLONE_CRYPT_PASSWORD:-}"

BRAIN_PATH="${BRAIN_PATH:-./brain}"
BRAIN_DIR="$BRAIN_PATH/brain"

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone not found; attempting to install..."
  curl -fsSL https://rclone.org/install.sh | bash
fi

# Configure standard remote
rclone config create hydra-gdrive drive \
  service_account_file "$GOOGLE_SERVICE_ACCOUNT_PATH" \
  root_folder_id "$GOOGLE_DRIVE_FOLDER_ID" >/dev/null 2>&1 || true

# Configure crypt remote layered on top if password is provided
if [[ -n "$RCLONE_CRYPT_PASSWORD" ]]; then
  rclone config create hydra-backup-crypt crypt \
    remote hydra-gdrive:/ password "$RCLONE_CRYPT_PASSWORD" >/dev/null 2>&1 || true
  SRC_REMOTE="hydra-backup-crypt:/"
  echo "Restoring encrypted backup to $BRAIN_DIR ..."
else
  SRC_REMOTE="hydra-gdrive:/"
  echo "Restoring unencrypted backup to $BRAIN_DIR ..."
fi

mkdir -p "$BRAIN_DIR"

rclone sync "$SRC_REMOTE" "$BRAIN_DIR/" --transfers 4 --progress

echo "Restore complete."
