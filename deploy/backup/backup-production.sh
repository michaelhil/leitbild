#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-critical}"
if [[ "$backup_scope" != critical && "$backup_scope" != static ]]; then
  echo 'Usage: backup-production.sh critical|static' >&2
  exit 2
fi

backup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_repository="${SAMSINN_BACKUP_REPOSITORY:-/Users/hilde/Documents/ChatGPT/server-backups/restic-repository}"
backup_ssh_host="${SAMSINN_SSH_HOST:-samsinn}"
backup_password_command="$backup_script_dir/restic-password.sh"
backup_archive_name="samsinn-stack-${backup_scope}.tar"

command -v restic >/dev/null || { echo 'restic is required' >&2; exit 1; }
[[ -d "$backup_repository" ]] || { echo "Restic repository is not initialized: $backup_repository" >&2; exit 1; }

ssh -C "$backup_ssh_host" "bash -s -- $backup_scope" < "$backup_script_dir/stream-production.sh" |
  restic --repo "$backup_repository" --password-command "$backup_password_command" \
    backup --stdin --stdin-filename "$backup_archive_name" \
    --host samsinn-production --tag "$backup_scope"

if [[ "$backup_scope" == critical ]]; then
  restic --repo "$backup_repository" --password-command "$backup_password_command" \
    forget --host samsinn-production --tag critical \
    --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
else
  restic --repo "$backup_repository" --password-command "$backup_password_command" \
    forget --host samsinn-production --tag static \
    --keep-weekly 8 --keep-monthly 12 --prune
fi
