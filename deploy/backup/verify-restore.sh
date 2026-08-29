#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-all}"
if [[ "$backup_scope" != critical && "$backup_scope" != static && "$backup_scope" != all ]]; then
  echo 'Usage: verify-restore.sh critical|static|all' >&2
  exit 2
fi

backup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_repository="${SAMSINN_BACKUP_REPOSITORY:-/Users/hilde/Documents/ChatGPT/server-backups/restic-repository}"
backup_password_command="$backup_script_dir/restic-password.sh"
backup_restore_root="$(mktemp -d /tmp/samsinn-restore-drill.XXXXXX)"
trap 'rm -rf -- "$backup_restore_root"' EXIT

backup_restore_scope() {
  local backup_requested_scope="$1"
  local backup_scope_root="$backup_restore_root/$backup_requested_scope"
  mkdir "$backup_scope_root"
  restic --repo "$backup_repository" --password-command "$backup_password_command" \
    dump --host samsinn-production --tag "$backup_requested_scope" latest \
    "samsinn-stack-${backup_requested_scope}.tar" |
    tar -xf - -C "$backup_scope_root"

  if [[ "$backup_requested_scope" == critical ]]; then
    [[ -d "$backup_scope_root/var/lib/samsinn" ]]
    [[ -d "$backup_scope_root/opt/leitbild/data" ]]
    [[ -s "$backup_scope_root/etc/caddy/Caddyfile" ]]
    [[ -s "$backup_scope_root/etc/systemd/system/samsinn.service" ]]
    [[ -s "$backup_scope_root/etc/systemd/system/leitbild.service" ]]
    [[ -s "$backup_scope_root/backup-metadata/leitbild-osrm.inspect.json" ]]
  else
    [[ -d "$backup_scope_root/opt/leitbild/maps" ]]
    [[ -d "$backup_scope_root/opt/leitbild/reference" ]]
    [[ -d "$backup_scope_root/opt/leitbild/osrm-data" ]]
    find "$backup_scope_root/opt/leitbild/maps" -type f -print -quit | grep -q .
    find "$backup_scope_root/opt/leitbild/reference" -type f -print -quit | grep -q .
    find "$backup_scope_root/opt/leitbild/osrm-data" -type f -print -quit | grep -q .
  fi
  echo "Restore drill passed for $backup_requested_scope backup."
}

restic --repo "$backup_repository" --password-command "$backup_password_command" check
if [[ "$backup_scope" == all ]]; then
  backup_restore_scope critical
  backup_restore_scope static
else
  backup_restore_scope "$backup_scope"
fi
