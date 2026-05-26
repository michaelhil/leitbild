#!/usr/bin/env bash
# One-time provisioning for the reference-data pipeline on Hetzner.
# Idempotent — re-running is safe.
set -euo pipefail

# 1. Install tippecanoe (the tile builder).
if ! command -v tippecanoe >/dev/null 2>&1; then
  echo "Installing tippecanoe…"
  apt-get update
  apt-get install -y tippecanoe
else
  echo "tippecanoe already present at $(command -v tippecanoe)"
fi

# 2. Create the on-disk layout.
mkdir -p /opt/leitbild/reference/sources
mkdir -p /opt/leitbild/reference/builds
mkdir -p /opt/leitbild/reference/releases

# 3. Lock down the secrets directory.
mkdir -p /etc/leitbild
chmod 700 /etc/leitbild
if [ ! -f /etc/leitbild/reference.env ]; then
  cat > /etc/leitbild/reference.env <<'EOF'
# Reference-data pipeline secrets. Owned by root, chmod 600.
# See docs/reference-data-pipeline.md.
OPENAIP_API_KEY=
EOF
  chmod 600 /etc/leitbild/reference.env
  echo "Created /etc/leitbild/reference.env — fill in OPENAIP_API_KEY"
else
  echo "/etc/leitbild/reference.env already present (left untouched)"
fi

# 4. Install + enable the systemd units.
cp /opt/leitbild/app/deploy/leitbild-reference-pull.service /etc/systemd/system/
cp /opt/leitbild/app/deploy/leitbild-reference-pull.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now leitbild-reference-pull.timer
echo "leitbild-reference-pull.timer enabled"

systemctl list-timers --all | grep -E '(leitbild-reference|NEXT)' || true
