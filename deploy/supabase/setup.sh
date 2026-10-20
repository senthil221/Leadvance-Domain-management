#!/bin/sh
# One-time setup of the trimmed Supabase stack on the VPS.
# Usage (on the VPS): sh setup.sh <app-host>
# Safe to re-run: it never overwrites an existing .env or database.
set -e

APP_HOST="${1:?usage: sh setup.sh <app-host>}"
SRC=/opt/src/supabase/docker
DIR=/docker/domain-engine-db
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR"
  cp -r "$SRC"/. "$DIR"/
fi
cp "$HERE/docker-compose.override.yml" "$DIR/docker-compose.override.yml"
cd "$DIR"

set_env() {
  # set_env KEY VALUE: replace the line if present, else append it
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  sh utils/generate-keys.sh --update-env > /dev/null
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env DASHBOARD_USERNAME admin
  set_env DASHBOARD_PASSWORD "$(openssl rand -hex 16)"
fi

set_env COMPOSE_FILE "docker-compose.yml:docker-compose.override.yml"
set_env API_GW_HTTP_PORT "127.0.0.1:54321"
set_env SUPABASE_PUBLIC_URL "http://localhost:54321"
set_env API_EXTERNAL_URL "http://localhost:54321/auth/v1"
set_env SITE_URL "https://$APP_HOST"
set_env DISABLE_SIGNUP true
set_env ENABLE_EMAIL_AUTOCONFIRM true
set_env ENABLE_PHONE_SIGNUP false
set_env STUDIO_DEFAULT_ORGANIZATION "Domain Engine"
set_env STUDIO_DEFAULT_PROJECT "Domain Engine"
chmod 600 .env

docker compose pull -q
docker compose up -d
docker compose ps --format "table {{.Name}}\t{{.Status}}"
