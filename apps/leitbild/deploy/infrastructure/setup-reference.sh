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

# Reference builds are intentionally manual. From the active immutable release,
# run the relevant reference:* command with its documented environment.
echo "Reference tooling ready; no timer was installed"
