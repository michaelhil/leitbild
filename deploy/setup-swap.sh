#!/usr/bin/env bash
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-8G}"

if swapon --show=NAME | grep -qx "$SWAP_FILE"; then
  echo "Swap already active at $SWAP_FILE"
  exit 0
fi

if [ ! -f "$SWAP_FILE" ]; then
  fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
fi

swapon "$SWAP_FILE"

if ! grep -q "^$SWAP_FILE " /etc/fstab; then
  printf "%s none swap sw 0 0\n" "$SWAP_FILE" >> /etc/fstab
fi

swapon --show
