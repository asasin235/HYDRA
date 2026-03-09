#!/usr/bin/env bash
# scripts/gws-auth-work.sh — Set up GWS OAuth for WORK account (aatif.rashid@goedmo.com)
#
# Prereqs:
#   - gcloud CLI installed at ~/Downloads/google-cloud-sdk/bin/gcloud
#   - Already authenticated with: gcloud auth login aatif.rashid@goedmo.com
#   - gws CLI installed: npm install -g @googleworkspace/cli
#
# What this script does:
#   1. Adds gcloud to PATH
#   2. Runs `gws auth setup` — interactively creates a GCP project (or reuses one),
#      enables Gmail/Calendar/Chat APIs, and creates an OAuth client credential.
#      Recommendation: create a NEW project named "hydra-gws" when prompted.
#   3. Runs `gws auth login` — opens browser for OAuth consent
#   4. Verifies the authentication and tests Gmail access
#   5. Copies client_secret.json to ~/.config/gws-personal/ for the personal script
#
# Run:
#   ./scripts/gws-auth-work.sh

set -e

export PATH="$HOME/Downloads/google-cloud-sdk/bin:$PATH"

GWS_BIN="${GWS_BIN:-gws}"
WORK_DIR="${GWS_WORK_CONFIG_DIR:-$HOME/.config/gws}"
PERSONAL_DIR="${GWS_PERSONAL_CONFIG_DIR:-$HOME/.config/gws-personal}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; exit 1; }
hdr()  { echo -e "\n${BOLD}── $* ──${RESET}\n"; }

# ── Checks ──────────────────────────────────────────────────────────────────

command -v "$GWS_BIN" &>/dev/null || err "gws not found. Run: npm install -g @googleworkspace/cli"
command -v gcloud &>/dev/null || err "gcloud not found at ~/Downloads/google-cloud-sdk/bin/gcloud"

ok "gws $(gws --version 2>&1 | head -1)"
ok "gcloud $(gcloud --version 2>&1 | head -1)"

GCLOUD_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
if [[ "$GCLOUD_ACCOUNT" != "aatif.rashid@goedmo.com" ]]; then
  warn "Active gcloud account is '${GCLOUD_ACCOUNT}', expected aatif.rashid@goedmo.com"
  warn "Run: gcloud auth login aatif.rashid@goedmo.com"
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

mkdir -p "$WORK_DIR" "$PERSONAL_DIR"

# ── Step 1: gws auth setup ────────────────────────────────────────────────────

hdr "Step 1: GCP project + OAuth setup (work)"
echo "  Config dir: $WORK_DIR"
echo "  Account:    aatif.rashid@goedmo.com"
echo ""
echo "  When prompted for a GCP project, we recommend creating a NEW project."
echo "  Suggested name: hydra-gws"
echo ""
echo "  The setup wizard will:"
echo "    • Create or select a GCP project"
echo "    • Enable Gmail, Calendar, and Chat APIs"
echo "    • Create an OAuth client credential"
echo ""
read -rp "  Press Enter to start setup wizard..."

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" \
  "$GWS_BIN" auth setup

# ── Step 2: gws auth login ────────────────────────────────────────────────────

hdr "Step 2: Browser OAuth login (work)"
echo "  A browser window will open — sign in as aatif.rashid@goedmo.com"
echo ""
read -rp "  Press Enter to open browser..."

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" \
  "$GWS_BIN" auth login --scopes "https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/chat.spaces,https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/userinfo.email"

# ── Step 3: Verify ────────────────────────────────────────────────────────────

hdr "Step 3: Verifying work account"

STATUS=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" "$GWS_BIN" auth status --format json 2>/dev/null || echo '{}')
AUTH_METHOD=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('auth_method','none'))" 2>/dev/null || echo "none")

if [[ "$AUTH_METHOD" != "none" && -n "$AUTH_METHOD" ]]; then
  ok "Auth verified (method: $AUTH_METHOD)"
else
  warn "Auth status unclear — raw output:"
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" "$GWS_BIN" auth status 2>&1 || true
fi

echo ""
echo "  Testing Gmail access (1 email)..."
GMAIL_TEST=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" \
  "$GWS_BIN" gmail +triage --format json --max 1 2>&1 || true)

if echo "$GMAIL_TEST" | grep -q '"from"\|"subject"\|\[\]'; then
  ok "Gmail access confirmed for aatif.rashid@goedmo.com"
else
  warn "Gmail test inconclusive. Check scopes in browser and retry if needed."
  echo "  Output: ${GMAIL_TEST:0:300}"
fi

# ── Step 4: Copy client_secret.json for personal script ───────────────────────

hdr "Step 4: Sharing credentials with personal profile"

if [[ -f "$WORK_DIR/client_secret.json" ]]; then
  cp "$WORK_DIR/client_secret.json" "$PERSONAL_DIR/client_secret.json"
  ok "Copied client_secret.json → $PERSONAL_DIR/"
  echo ""
  echo "  IMPORTANT: Before running gws-auth-personal.sh, you must add"
  echo "  aatif20@gmail.com as a test user in GCP OAuth consent screen:"
  echo ""
  echo "  1. Go to: https://console.cloud.google.com/apis/credentials/consent"
  echo "  2. Select your hydra-gws project"
  echo "  3. Click 'Add Users' under 'Test users'"
  echo "  4. Add: aatif20@gmail.com"
  echo "  5. Save"
  echo ""
  echo "  Then run: ./scripts/gws-auth-personal.sh"
else
  warn "client_secret.json not found at $WORK_DIR/ — personal auth will need separate credentials"
  echo "  You may need to download client_secret.json manually from GCP Console:"
  echo "  https://console.cloud.google.com/apis/credentials"
fi

hdr "Work account setup complete"
echo "  HYDRA edmobot can now access:"
echo "    📧 Gmail (aatif.rashid@goedmo.com)"
echo "    📅 Google Calendar"
echo "    💬 Google Chat"
echo ""
echo "  Start background sync:"
echo "    pm2 start ecosystem.config.cjs --only gws-sync"
echo ""
ok "Done!"
