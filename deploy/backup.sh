#!/bin/sh
# Nightly Postgres backup for Domain Engine. Keeps 14 days locally; copies
# off the server too when an rclone remote named "offsite" is configured.
# Install (on the VPS):  crontab -e  →  15 3 * * * sh /docker/domain-engine/deploy/backup.sh
set -e

DIR=/var/backups/domain-engine
mkdir -p "$DIR"
FILE="$DIR/domain-engine-$(date +%F).dump"

docker exec supabase-db pg_dump -U postgres -d postgres -Fc --no-owner > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
find "$DIR" -name 'domain-engine-*.dump' -mtime +14 -delete

if command -v rclone >/dev/null 2>&1 && rclone listremotes | grep -q '^offsite:'; then
  rclone copy "$FILE" offsite:domain-engine-backups/
fi
echo "backup written: $FILE"
