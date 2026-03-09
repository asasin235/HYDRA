#!/usr/bin/env bash
# Re-auth work account adding chat.spaces.readonly scope (needed for gws chat spaces list)
# Run: ./scripts/gws-reauth-chat.sh

set -e
WORK_DIR="${GWS_WORK_CONFIG_DIR:-$HOME/.config/gws}"

echo "Re-authenticating work account with chat.spaces.readonly scope..."
echo "A browser window will open — sign in as aatif.rashid@goedmo.com"
echo ""
read -rp "Press Enter to continue..."

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" gws auth login \
  --scopes "https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/chat.spaces,https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/userinfo.email"

echo ""
echo "Testing GChat access..."
RESULT=$(GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$WORK_DIR" gws chat spaces list --format json 2>&1)
if echo "$RESULT" | grep -q '"spaces"\|"name"'; then
  echo "✓ GChat access confirmed"
  echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' -', s.get('displayName','?')) for s in d.get('spaces',[])]" 2>/dev/null || true
else
  echo "⚠ GChat still not accessible. Output: ${RESULT:0:200}"
fi
