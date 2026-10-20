#!/bin/bash
# Creates a Domain Engine login (Supabase Auth admin API). Run on the VPS:
#   ssh -t root@<vps> bash /docker/domain-engine/deploy/create-user.sh
# Asks for the email and password; the password is never echoed or logged.
set -euo pipefail

KEY=$(grep '^SERVICE_ROLE_KEY=' /docker/domain-engine-db/.env | cut -d= -f2-)

# Minimal JSON string escaping for backslashes and quotes.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

read -rp "Email: " EMAIL
read -rsp "Password (8+ characters): " PASS; echo
read -rsp "Repeat password: " PASS2; echo

if [ "$PASS" != "$PASS2" ]; then echo "Passwords don't match. Nothing was created."; exit 1; fi
if [ ${#PASS} -lt 8 ]; then echo "Use at least 8 characters. Nothing was created."; exit 1; fi

RES=$(curl -s -X POST http://127.0.0.1:54321/auth/v1/admin/users \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  --data-binary @- <<EOF
{"email":"$(esc "$EMAIL")","password":"$(esc "$PASS")","email_confirm":true}
EOF
)

if printf '%s' "$RES" | grep -q '"id"'; then
  echo "Created login for $EMAIL. Sign in at https://domains.srv1826728.hstgr.cloud"
else
  echo "Not created: $(printf '%s' "$RES" | grep -o '"msg":"[^"]*"\|"message":"[^"]*"\|"error_description":"[^"]*"' | head -1)"
  exit 1
fi
