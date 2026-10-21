#!/bin/bash
# Sets one API key in the app's .env without it appearing on screen, in shell
# history or in logs, then restarts the app and worker so they pick it up and
# runs that integration's sync jobs on the worker's next tick.
#   ssh -t root@<vps> bash /docker/domain-engine/deploy/set-secret.sh SMARTLEAD_API_KEY
set -euo pipefail

ALLOWED="SMARTLEAD_API_KEY SMARTLEAD_JWT PORKBUN_API_KEY PORKBUN_SECRET_KEY UNSTOPPABLE_API_KEY HYPERTIDE_API_KEY HYPERTIDE_API_URL HYPERTIDE_SMARTLEAD_USERNAME HYPERTIDE_SMARTLEAD_PASSWORD HYPERTIDE_SMARTLEAD_OAUTH_LINK INTEGRATIONS_DRY_RUN"
NAME="${1:-}"
if [[ " $ALLOWED " != *" $NAME "* ]]; then
  echo "Usage: set-secret.sh <$(echo $ALLOWED | tr ' ' '|')>"
  exit 1
fi

ENV=/docker/domain-engine/deploy/app/.env
read -rsp "Value for $NAME (hidden): " VALUE; echo
VALUE="$(printf '%s' "$VALUE" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if [ -z "$VALUE" ]; then echo "Empty value. Nothing was changed."; exit 1; fi

# A Smartlead token copied from a request often carries "Bearer " or quotes.
if [ "$NAME" = SMARTLEAD_JWT ]; then VALUE="${VALUE#Bearer }"; VALUE="${VALUE#bearer }"; VALUE="${VALUE//\"/}"; fi

# Catch the common mix-ups (secret pasted as key, another service's key).
case "$NAME" in
  SMARTLEAD_JWT)        [[ "$VALUE" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || { echo "A Smartlead token has three parts separated by dots (copy the value after 'Bearer '). Nothing was changed."; exit 1; } ;;
  PORKBUN_API_KEY)      [[ "$VALUE" == pk1_* ]] || { echo "Porkbun API keys start with pk1_. Nothing was changed."; exit 1; } ;;
  PORKBUN_SECRET_KEY)   [[ "$VALUE" == sk1_* ]] || { echo "Porkbun secret keys start with sk1_. Nothing was changed."; exit 1; } ;;
  INTEGRATIONS_DRY_RUN) [[ "$VALUE" == true || "$VALUE" == false ]] || { echo "Use true or false. Nothing was changed."; exit 1; } ;;
  HYPERTIDE_API_URL)    [[ "$VALUE" == https://* ]] || { echo "The Hypertide API URL starts with https://. Nothing was changed."; exit 1; } ;;
  HYPERTIDE_SMARTLEAD_OAUTH_LINK) [[ "$VALUE" == https://login.microsoftonline.com* ]] || { echo "The Smartlead Microsoft OAuth link starts with https://login.microsoftonline.com. Nothing was changed."; exit 1; } ;;
  HYPERTIDE_SMARTLEAD_USERNAME) [[ "$VALUE" == *@*.* ]] || { echo "Use the email address you log in to Smartlead with. Nothing was changed."; exit 1; } ;;
  *)                    [[ "$VALUE" == pk1_* || "$VALUE" == sk1_* ]] && { echo "That looks like a Porkbun key, not $NAME. Nothing was changed."; exit 1; } ;;
esac

# Drop any old line and append the new one, so the value is stored exactly.
touch "$ENV"; chmod 600 "$ENV"
TMP="$(mktemp)"; chmod 600 "$TMP"
grep -v "^$NAME=" "$ENV" > "$TMP" || true
printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
mv "$TMP" "$ENV"; chmod 600 "$ENV"
unset VALUE

# Make that integration's jobs due now rather than at their next interval.
case "$NAME" in
  SMARTLEAD_*) JOBS="smartlead-%" ;;
  PORKBUN_*)   JOBS="porkbun-%" ;;
  HYPERTIDE_*) JOBS="hypertide-%" ;;
  *)           JOBS="" ;;
esac
if [ -n "$JOBS" ]; then
  docker exec supabase-db psql -U postgres -d postgres -qc "update job_state set last_started_at = null where job like '$JOBS'" >/dev/null 2>&1 || true
fi

echo "Saved $NAME. Restarting app and worker..."
cd /docker/domain-engine/deploy/app && docker compose up -d web worker >/dev/null 2>&1
echo "Done. Check Settings → Background sync in the app in a minute."
