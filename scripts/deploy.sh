#!/usr/bin/env bash
# Runs ON THE SERVER (piped over SSH by .github/workflows/ci-cd.yml).
# Fast-forwards the app to the tested commit, installs production deps, restarts pm2 and
# checks /healthz. If the new version does not come up healthy, it rolls back.
#
# Env: SHA (commit to deploy, required), APP_DIR (default /var/www/ludo),
#      PM2_NAME (default ludo), BRANCH (default main).
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/ludo}"
PM2_NAME="${PM2_NAME:-ludo}"
BRANCH="${BRANCH:-main}"
: "${SHA:?SHA is required}"

# Non-interactive SSH shells skip profile files; load nvm if Node was installed with it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$APP_DIR"
PREV="$(git rev-parse HEAD)"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '"'"'"' \r' || true)"
PORT="${PORT:-8080}"

restart() {
  npm ci --omit=dev --no-audit --no-fund
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    pm2 restart "$PM2_NAME" --update-env
  else
    pm2 start server/index.js --name "$PM2_NAME"
  fi
  pm2 save >/dev/null
}

healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

echo "Deploying ${SHA} (was ${PREV}) in ${APP_DIR}"
git fetch --quiet origin "$BRANCH"
# Fast-forward only: refuses to run over local edits or diverged history instead of erasing them.
git merge --ff-only "$SHA"
restart

if healthy; then
  echo "Healthy on port ${PORT}: $(git log --oneline -1)"
else
  echo "Health check failed on port ${PORT}; rolling back to ${PREV}" >&2
  pm2 logs "$PM2_NAME" --lines 40 --nostream || true
  git reset --hard "$PREV"
  restart
  healthy && echo "Rolled back to ${PREV}" >&2
  exit 1
fi
