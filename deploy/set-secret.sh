#!/bin/bash
# Sets one API key in the app's .env without it appearing on screen, in shell
# history or in logs, then restarts the app and worker so they pick it up.
#   ssh -t root@<vps> bash /docker/domain-engine/deploy/set-secret.sh SMARTLEAD_API_KEY
set -euo pipefail

ALLOWED="SMARTLEAD_API_KEY PORKBUN_API_KEY PORKBUN_SECRET_KEY UNSTOPPABLE_API_KEY HYPERTIDE_API_KEY INTEGRATIONS_DRY_RUN"
NAME="${1:-}"
if [[ " $ALLOWED " != *" $NAME "* ]]; then
  echo "Usage: set-secret.sh <$(echo $ALLOWED | tr ' ' '|')>"
  exit 1
fi

ENV=/docker/domain-engine/deploy/app/.env
read -rsp "Value for $NAME (hidden): " VALUE; echo
VALUE="$(printf '%s' "$VALUE" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if [ -z "$VALUE" ]; then echo "Empty value. Nothing was changed."; exit 1; fi

# Drop any old line and append the new one, so the value is stored exactly.
touch "$ENV"; chmod 600 "$ENV"
TMP="$(mktemp)"; chmod 600 "$TMP"
grep -v "^$NAME=" "$ENV" > "$TMP" || true
printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
mv "$TMP" "$ENV"; chmod 600 "$ENV"
unset VALUE
echo "Saved $NAME. Restarting app and worker..."
cd /docker/domain-engine/deploy/app && docker compose up -d web worker >/dev/null 2>&1
echo "Done. Check Settings → Connections in the app."
