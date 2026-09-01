#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-all}"
if [[ "$backup_scope" != critical && "$backup_scope" != static && "$backup_scope" != all ]]; then
  echo 'Usage: verify-restore.sh critical|static|all' >&2
  exit 2
fi

backup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_account="$(id -un)"
backup_account_root="$(dscl . -read "/Users/$backup_account" NFSHomeDirectory | awk '{print $2}')"
backup_repository="${LEITBILD_BACKUP_REPOSITORY:-$backup_account_root/Documents/ChatGPT/server-backups/restic-repository}"
backup_password_command="$backup_script_dir/restic-password.sh"
backup_restic_bin="${LEITBILD_RESTIC_BIN:-/opt/homebrew/bin/restic}"
backup_restore_root="$(mktemp -d /tmp/leitbild-restore-drill.XXXXXX)"
trap 'rm -rf -- "$backup_restore_root"' EXIT

backup_restore_scope() {
  local backup_requested_scope="$1"
  local backup_scope_root="$backup_restore_root/$backup_requested_scope"
  mkdir "$backup_scope_root"
  "$backup_restic_bin" --repo "$backup_repository" --password-command "$backup_password_command" \
    dump --host leitbild-production --tag "$backup_requested_scope" latest \
    "leitbild-${backup_requested_scope}.tar" |
    tar -xf - -C "$backup_scope_root"

  if [[ "$backup_requested_scope" == critical ]]; then
    [[ -s "$backup_scope_root/var/lib/leitbild/host/workspaces.sqlite" ]]
    [[ -d "$backup_scope_root/var/lib/leitbild/world" ]]
    [[ -d "$backup_scope_root/var/lib/leitbild/agents" ]]
    [[ -s "$backup_scope_root/etc/caddy/Caddyfile" ]]
    [[ -s "$backup_scope_root/etc/systemd/system/leitbild-world.service" ]]
    [[ -s "$backup_scope_root/etc/systemd/system/leitbild-agents.service" ]]
    [[ -s "$backup_scope_root/etc/systemd/system/leitbild-host.service" ]]
    [[ -s "$backup_scope_root/backup-metadata/leitbild-osrm.inspect.json" ]]
    [[ -s "$backup_scope_root/backup-metadata/current-release.txt" ]]
  else
    for backup_path in maps reference osrm-data; do
      [[ -d "$backup_scope_root/opt/leitbild/$backup_path" ]]
      find "$backup_scope_root/opt/leitbild/$backup_path" -type f -print -quit | grep -q .
    done
  fi
  echo "Restore drill passed for $backup_requested_scope backup."
}

"$backup_restic_bin" --repo "$backup_repository" --password-command "$backup_password_command" check
if [[ "$backup_scope" == all ]]; then
  backup_restore_scope critical
  backup_restore_scope static
else
  backup_restore_scope "$backup_scope"
fi
