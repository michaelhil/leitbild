#!/usr/bin/env bash
set -euo pipefail

agents_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$agents_root"

bun run check
bun run type-coverage --strict --ignore-catch --at-least 98
bun run dependency-cruiser "src/**/*.ts" --output-type err

echo 'Agents health checks passed.'
