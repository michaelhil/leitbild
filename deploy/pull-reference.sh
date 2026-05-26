#!/usr/bin/env bash
# Worker script for the leitbild-reference-pull.timer.
# Builds and promotes all registered reference datasets, with conditional GET
# against upstream sources so unchanged data is a no-op.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/leitbild/app}"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"
REFERENCE_ROOT="${LEITBILD_REFERENCE_ROOT:-/opt/leitbild/reference}"

if [ ! -d "$APP_DIR" ]; then
  echo "Leitbild application directory missing at $APP_DIR" >&2
  exit 1
fi

if ! command -v tippecanoe >/dev/null 2>&1; then
  echo "tippecanoe not installed. Run deploy/setup-reference.sh once on this host." >&2
  exit 1
fi

if [ -z "${OPENAIP_API_KEY:-}" ]; then
  echo "OPENAIP_API_KEY not set. Place it in /etc/leitbild/reference.env (chmod 600)." >&2
  exit 1
fi

mkdir -p "$REFERENCE_ROOT/sources" "$REFERENCE_ROOT/builds" "$REFERENCE_ROOT/releases"

cd "$APP_DIR"
LEITBILD_REFERENCE_ROOT="$REFERENCE_ROOT" "$BUN_BIN" run reference:rebuild
