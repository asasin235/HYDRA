#!/usr/bin/env bash
set -euo pipefail

: "${B2_ACCOUNT_ID:?Missing B2_ACCOUNT_ID}"
: "${B2_APP_KEY:?Missing B2_APP_KEY}"
: "${B2_BUCKET:?Missing B2_BUCKET}"
: "${RCLONE_CRYPT_PASSWORD:?Missing RCLONE_CRYPT_PASSWORD}"

PI_SMB_PATH="${PI_SMB_PATH:-./brain}"
BRAIN_DIR="$PI_SMB_PATH/brain"

if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone not found; attempting to install..."
  curl -fsSL https://rclone.org/install.sh | bash
fi

# Configure remotes (idempotent)
rclone config create hydra-backup b2 account "$B2_ACCOUNT_ID" key "$B2_APP_KEY" >/dev/null 2>&1 || true
rclone config create hydra-backup-crypt crypt remote hydra-backup:"$B2_BUCKET" password "$RCLONE_CRYPT_PASSWORD" >/dev/null 2>&1 || true

mkdir -p "$BRAIN_DIR"

echo "Restoring encrypted backup to $BRAIN_DIR ..."
rclone sync hydra-backup-crypt:/ "$BRAIN_DIR/" --transfers 4 --progress

echo "Restore complete."
