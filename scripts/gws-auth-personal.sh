#!/usr/bin/env bash
# scripts/gws-auth-personal.sh — Authenticate GWS for PERSONAL account (aatif20@gmail.com)
#
# Prereqs:
#   - Run gws-auth-work.sh FIRST — it creates the shared OAuth client credentials
#   - Add aatif20@gmail.com as a test user in GCP OAuth consent screen:
#       https://console.cloud.google.com/apis/credentials/consent
#       → Select hydra-gws project → Test users → Add users → aatif20@gmail.com
#
# What this script does:
#   1. Verifies client_secret.json exists (copied from work setup)
#   2. Runs `gws auth login` — opens browser for personal OAuth consent
#   3. Verifies authentication and tests Gmail access
#
# Run:
#   ./scripts/gws-auth-personal.sh

set -e

GWS_BIN="${GWS_BIN:-gws}"
PERSONAL_DIR="${GWS_PERSONAL_CONFIG_DIR:-$HOME/.config/gws-personal}"
WORK_DIR="${GWS_WORK_CONFIG_DIR:-$HOME/.config/gws-work}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; exit 1; }
hdr()  { echo -e "\n${BOLD}── $* ──${RESET}\n"; }

# ── Checks ──────────────────────────────────────────────────────────────────

command -v "$GWS_BIN" &>/dev/null || err "gws not found. Run: npm install -g @googleworkspace/cli"

ok "gws $(gws --version 2>&1 | head -1)"

mkdir -p "$PERSONAL_DIR"

# Ensure client_secret.json exists
if [[ ! -f "$PERSONAL_DIR/client_secret.json" ]]; then
  # Try to copy from work profile
  if [[ -f "$WORK_DIR/client_secret.json" ]]; then
    cp "$WORK_DIR/client_secret.json" "$PERSONAL_DIR/client_secret.json"
    ok "Copied client_secret.json from work profile"
  else
    echo ""
    err "client_secret.json not found. Please either:
  1. Run ./scripts/gws-auth-work.sh first (recommended), OR
  2. Download client_secret.json from:
       https://console.cloud.google.com/apis/credentials
     and save it to: $PERSONAL_DIR/client_secret.json"
  fi
fi

ok "client_secret.json found at $PERSONAL_DIR/"

# ── Pre-flight reminder ───────────────────────────────────────────────────────

hdr "Before continuing — confirm test user is added"
echo "  Make sure aatif20@gmail.com is added as a test user in GCP:"
echo ""
echo "  1. https://console.cloud.google.com/apis/credentials/consent"
echo "  2. Select your hydra-gws project"
echo "  3. Scroll to 'Test users' → 'Add users'"
echo "  4. Add: aatif20@gmail.com → Save"
echo ""
echo "  (Skip if already done)"
echo ""
read -rp "  Press Enter when ready..."

# ── Step 1: gws auth login ────────────────────────────────────────────────────

hdr "Step 1: Browser OAuth login (personal)"
echo "  Config dir: $PERSONAL_DIR"
echo "  Account:    aatif20@gmail.com"
echo ""
echo "  A browser window will open — sign in as aatif20@gmail.com"
echo "  If you see a warning about unverified app, click 'Advanced' → 'Continue'"
echo ""
read -rp "  Press Enter to open browser..."

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PERSONAL_DIR" \
  "$GWS_BIN" auth login -s gmail,calendar,chat

# ── Step 2: Verify ────────────────────────────────────────────────────────────

hdr "Step 2: Verifying personal account"

STATUS=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PERSONAL_DIR" "$GWS_BIN" auth status --format json 2>/dev/null || echo '{}')
AUTH_METHOD=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('auth_method','none'))" 2>/dev/null || echo "none")

if [[ "$AUTH_METHOD" != "none" && -n "$AUTH_METHOD" ]]; then
  ok "Auth verified (method: $AUTH_METHOD)"
else
  warn "Auth status unclear — raw output:"
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PERSONAL_DIR" "$GWS_BIN" auth status 2>&1 || true
fi

echo ""
echo "  Testing Gmail access (1 email)..."
GMAIL_TEST=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PERSONAL_DIR" \
  "$GWS_BIN" gmail +triage --format json --max 1 2>&1 || true)

if echo "$GMAIL_TEST" | grep -q '"from"\|"subject"\|\[\]'; then
  ok "Gmail access confirmed for aatif20@gmail.com"
else
  warn "Gmail test inconclusive. If you got a 401, check test users in GCP consent screen."
  echo "  Output: ${GMAIL_TEST:0:300}"
fi

hdr "Personal account setup complete"
echo "  HYDRA socialbot can now access:"
echo "    📧 Gmail (aatif20@gmail.com)"
echo "    📅 Google Calendar"
echo "    💬 Google Chat"
echo ""
echo "  Start background sync (if not already running):"
echo "    pm2 start ecosystem.config.cjs --only gws-sync"
echo "    # or if already running:"
echo "    pm2 restart gws-sync"
echo ""
ok "Done! Both accounts are now configured."
