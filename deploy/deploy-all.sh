#!/bin/bash
# Ships the current commit to every Domain Engine server, one after another,
# and stops at the first one that fails so the next stays on a working build.
#   bash deploy/deploy-all.sh            # all servers
#   bash deploy/deploy-all.sh srv1033325 # just one (match on name)
# Run from Git Bash on your computer, in the project folder. Each server keeps
# its own deploy/app/.env (accounts, keys, host), which this never touches.
set -euo pipefail

# name  ssh-target  ssh-key
SERVERS=(
  "srv1826728 root@200.97.170.1 $HOME/.ssh/hostinger_vps"
  "srv1033325 root@72.60.201.43 $HOME/.ssh/id_ed25519"
)
APP=/docker/domain-engine

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes. Commit them first so both servers run the same commit."; exit 1
fi
git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then
  echo "This commit is not on GitHub yet. Run git push first."; exit 1
fi
COMMIT="$(git rev-parse --short HEAD)"
echo "Deploying $COMMIT: $(git log -1 --format=%s)"

for entry in "${SERVERS[@]}"; do
  read -r NAME TARGET KEY <<<"$entry"
  if [ -n "${1:-}" ] && [[ "$NAME" != *"$1"* ]]; then continue; fi
  echo; echo "== $NAME"
  ssh_() { ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$TARGET" "$@"; }

  # Folders that only hold tracked code are cleared first so deleted files go too.
  # The running containers use built images, so the site stays up meanwhile.
  git ls-files -z | tar --null -T - -czf - |
    ssh_ "cd $APP && rm -rf src scripts supabase public tests && tar -xzf - && echo $COMMIT > .deployed-commit"

  ssh_ "cd $APP/deploy/app &&
    docker compose build -q web worker &&
    docker compose run --rm migrate &&
    docker compose up -d web worker &&
    docker image prune -f >/dev/null"

  HOST="$(ssh_ "grep '^APP_HOST=' $APP/deploy/app/.env | cut -d= -f2-")"
  for i in $(seq 1 20); do
    if curl -fsS -m 10 "https://$HOST/api/health" >/dev/null 2>&1; then break; fi
    [ "$i" = 20 ] && { echo "$NAME: https://$HOST/api/health is not answering. Stopping here."; exit 1; }
    sleep 3
  done
  echo "$NAME: $COMMIT live at https://$HOST"
done

echo; echo "All done."
