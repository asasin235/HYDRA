#!/usr/bin/env bash
# scripts/gws-auth-setup.sh — Set up Google Workspace auth for both HYDRA accounts.
#
# Run this once when you first set up GWS integration, or after revoking tokens.
# The script handles both accounts sequentially — a browser window opens for each.
#
# Usage:
#   ./scripts/gws-auth-setup.sh              # auth both accounts
#   ./scripts/gws-auth-setup.sh personal     # re-auth personal only
#   ./scripts/gws-auth-setup.sh work         # re-auth work only
#
# Accounts:
#   personal → aatif20@gmail.com       (used by 04-socialbot)
#   work     → aatif.rashid@goedmo.com (used by 01-edmobot)

set -e

GWS_BIN="${GWS_BIN:-gws}"
PERSONAL_DIR="${GWS_PERSONAL_CONFIG_DIR:-$HOME/.config/gws-personal}"
WORK_DIR="${GWS_WORK_CONFIG_DIR:-$HOME/.config/gws-work}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; }
hdr()  { echo -e "\n${BOLD}$*${RESET}"; }

# Check gws is installed
if ! command -v "$GWS_BIN" &>/dev/null; then
  err "gws not found. Installing..."
  npm install -g @googleworkspace/cli
fi

ok "gws $(gws --version 2>&1 | head -1) found at $(which $GWS_BIN)"

auth_profile() {
  local profile="$1"
  local config_dir="$2"
  local email="$3"

  hdr "── $profile account ($email) ──"
  mkdir -p "$config_dir"
  echo ""
  echo "  Config dir: $config_dir"
  echo "  Services:   gmail, calendar, chat"
  echo ""
  warn "A browser window will open. Sign in as ${BOLD}${email}${RESET}."
  echo "  Press Enter to continue..."
  read -r

  GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$config_dir" \
    "$GWS_BIN" auth login -s gmail,calendar,chat

  echo ""
  echo "  Verifying auth..."
  local status
  status=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$config_dir" "$GWS_BIN" auth status 2>&1 || true)
  if echo "$status" | grep -qi "authenticated\|token"; then
    ok "Auth successful for $email"
  else
    warn "Could not verify auth status. Check manually:"
    echo "    GOOGLE_WORKSPACE_CLI_CONFIG_DIR=$config_dir gws auth status"
  fi

  echo ""
  echo "  Testing Gmail access (fetching 1 email)..."
  local test_out
  test_out=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$config_dir" \
    "$GWS_BIN" gmail +triage --format json --max 1 2>&1 || true)
  if echo "$test_out" | grep -q '"from"\|"subject"\|\[\]'; then
    ok "Gmail access confirmed for $email"
  else
    warn "Gmail test inconclusive. You may need to approve OAuth scopes in the browser."
    echo "    Raw output: ${test_out:0:200}"
  fi
}

PROFILE="${1:-both}"

case "$PROFILE" in
  personal)
    auth_profile "personal" "$PERSONAL_DIR" "aatif20@gmail.com"
    ;;
  work)
    auth_profile "work" "$WORK_DIR" "aatif.rashid@goedmo.com"
    ;;
  both|"")
    auth_profile "personal" "$PERSONAL_DIR" "aatif20@gmail.com"
    auth_profile "work" "$WORK_DIR" "aatif.rashid@goedmo.com"
    ;;
  *)
    err "Unknown profile '$PROFILE'. Use: personal | work | both"
    exit 1
    ;;
esac

hdr "── Setup Complete ──"
echo ""
echo "  Config dirs:"
echo "    personal: $PERSONAL_DIR"
echo "    work:     $WORK_DIR"
echo ""
echo "  These are referenced by:"
echo "    GWS_PERSONAL_CONFIG_DIR and GWS_WORK_CONFIG_DIR in .env"
echo ""
echo "  Start the gws-sync background service:"
echo "    pm2 start ecosystem.config.cjs --only gws-sync"
echo ""
ok "Done! HYDRA agents can now access Google Workspace."
