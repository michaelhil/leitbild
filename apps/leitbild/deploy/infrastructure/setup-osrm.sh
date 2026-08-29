#!/usr/bin/env bash
set -euo pipefail

OSRM_DIR="${OSRM_DIR:-/opt/leitbild/osrm-data}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/norway-latest.osm.pbf}"
PBF_FILE="${PBF_FILE:-norway-latest.osm.pbf}"
OSRM_BASE="${OSRM_BASE:-norway-latest.osrm}"

mkdir -p "$OSRM_DIR"
cd "$OSRM_DIR"

if [ ! -f "$PBF_FILE" ]; then
  curl -L -o "$PBF_FILE" "$PBF_URL"
fi

docker pull ghcr.io/project-osrm/osrm-backend

docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua "/data/$PBF_FILE"

docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition "/data/$OSRM_BASE"

docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize "/data/$OSRM_BASE"

docker rm -f leitbild-osrm >/dev/null 2>&1 || true
docker run -d \
  --name leitbild-osrm \
  --restart unless-stopped \
  -p 127.0.0.1:5000:5000 \
  -v "$PWD:/data" \
  ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld "/data/$OSRM_BASE"

curl -fsS "http://127.0.0.1:5000/route/v1/driving/10.7522,59.9139;10.7750,59.9120?overview=false" >/dev/null
echo "OSRM is running on 127.0.0.1:5000"
