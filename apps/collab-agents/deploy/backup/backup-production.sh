#!/usr/bin/env bash
set -euo pipefail

backup_scope="${1:-critical}"
if [[ "$backup_scope" != critical && "$backup_scope" != static ]]; then
  echo 'Usage: backup-production.sh critical|static' >&2
  exit 2
fi

backup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_repository="${LEITBILD_BACKUP_REPOSITORY:-/Users/hilde/Documents/ChatGPT/server-backups/restic-repository}"
backup_ssh_host="${LEITBILD_SSH_HOST:-leitbild}"
backup_password_command="$backup_script_dir/restic-password.sh"
backup_archive_name="leitbild-stack-${backup_scope}.tar"
backup_restic_bin="${LEITBILD_RESTIC_BIN:-/opt/homebrew/bin/restic}"

[[ -x "$backup_restic_bin" ]] || { echo "restic is required at $backup_restic_bin" >&2; exit 1; }
[[ -d "$backup_repository" ]] || { echo "Restic repository is not initialized: $backup_repository" >&2; exit 1; }

ssh -C "$backup_ssh_host" "bash -s -- $backup_scope" < "$backup_script_dir/stream-production.sh" |
  "$backup_restic_bin" --repo "$backup_repository" --password-command "$backup_password_command" \
    backup --stdin --stdin-filename "$backup_archive_name" \
    --host leitbild-production --tag "$backup_scope"

if [[ "$backup_scope" == critical ]]; then
  "$backup_restic_bin" --repo "$backup_repository" --password-command "$backup_password_command" \
    forget --host leitbild-production --tag critical \
    --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
else
  "$backup_restic_bin" --repo "$backup_repository" --password-command "$backup_password_command" \
    forget --host leitbild-production --tag static \
    --keep-weekly 8 --keep-monthly 12 --prune
fi
