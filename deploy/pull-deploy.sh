#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/leitbild/app}"
REPO_URL="${REPO_URL:-https://github.com/michaelhil/leitbild.git}"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin main
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "Leitbild already at $LOCAL_SHA"
  exit 0
fi

git reset --hard origin/main
"$BUN_BIN" install --frozen-lockfile
"$BUN_BIN" run check
"$BUN_BIN" test
"$BUN_BIN" run build:ui

cp deploy/leitbild.service /etc/systemd/system/leitbild.service
systemctl daemon-reload
systemctl enable --now leitbild
systemctl restart leitbild
curl -fsS http://127.0.0.1:4177/health >/dev/null

echo "Leitbild deployed $REMOTE_SHA"
